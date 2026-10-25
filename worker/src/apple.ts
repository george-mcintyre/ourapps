// App Store Connect API: ES256 tokens, the signing certificate, App IDs, profiles and TestFlight.
import type { Deps, Env } from "./env.js";
import { applePlatformName, type ApplePlatform } from "./apple-platform.js";
import { numericBuildNumber } from "./build-number.js";

export interface AppleCredentials {
  issuerId: string;
  keyId: string;
  privateKey: string;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

// Token lifetime stays under Apple's 20 minute ceiling.
export async function makeToken(creds: AppleCredentials, now: Date): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(creds.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: creds.keyId, typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({ iss: creds.issuerId, iat, exp: iat + 10 * 60, aud: "appstoreconnect-v1" })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

interface Linkage {
  id: string;
  type: string;
}

const asList = (data: Linkage | Linkage[] | undefined): Linkage[] => (data === undefined ? [] : Array.isArray(data) ? data : [data]);

interface Resource<A = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: A;
  // To-one relationships (bundleId) carry one object; to-many (certificates) an array.
  relationships?: Record<string, { data?: Linkage | Linkage[] }>;
}

interface BuildNumberPage {
  data: Resource<{ version: string }>[];
  included?: Resource<{ version?: string; platform?: string }>[];
  links?: { next?: string | null };
  meta?: { paging?: { total?: number } };
}

export class AppleClient {
  // One token serves every call in a request, keeping CPU time inside the Workers free plan.
  private token: { value: string; until: number } | null = null;

  constructor(private env: Env, private deps: Deps, private creds: AppleCredentials) {}

  private async bearer(): Promise<string> {
    const now = this.deps.now();
    if (!this.token || now.getTime() > this.token.until) this.token = { value: await makeToken(this.creds, now), until: now.getTime() + 5 * 60_000 };
    return this.token.value;
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = await this.bearer();
    const res = await this.deps.fetch(`${this.env.APPLE_API_BASE}${path}`, {
      method,
      signal, redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status >= 300 && res.status < 400) throw new AppleError(res.status, "Apple redirected the request; no credentials were forwarded.");
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & { errors?: { detail?: string; title?: string }[] };
    if (!res.ok) {
      const detail = json.errors?.map((e) => e.detail ?? e.title).join("; ") ?? res.statusText;
      throw new AppleError(res.status, `${method} ${path}: ${detail}`);
    }
    return json;
  }

  // Exact name match; Apple's name filter is not guaranteed to be exact.
  async findProfileByName(name: string): Promise<Resource<{ name: string; uuid: string; profileContent: string; expirationDate: string }> | null> {
    const res = await this.call<{ data: Resource<{ name: string; uuid: string; profileContent: string; expirationDate: string }>[] }>(
      "GET",
      `/v1/profiles?filter[name]=${encodeURIComponent(name)}&include=bundleId,certificates&limit=200`,
    );
    return res.data.find((p) => p.attributes.name === name) ?? null;
  }

  // Returns Apple's id for an explicit App ID, creating it when it does not exist yet.
  async ensureBundleId(identifier: string, appName: string, nativeMac = false): Promise<string> {
    const res = await this.call<{ data: Resource<{ identifier: string; platform?: string }>[] }>("GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`);
    const expected = nativeMac ? "MAC_OS" : "IOS";
    const found = res.data.find((b) => b.attributes.identifier === identifier && (b.attributes.platform === "UNIVERSAL" || b.attributes.platform === expected || (!nativeMac && b.attributes.platform === undefined)));
    if (found) return found.id;
    const name = `ourapps ${appName}`.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    const created = await this.call<{ data: Resource }>("POST", "/v1/bundleIds", {
      data: { type: "bundleIds", attributes: { identifier, name, platform: nativeMac ? "MAC_OS" : "IOS" } },
    });
    return created.data.id;
  }

  // TestFlight

  // The App Store Connect app for a bundle ID. Apple has no API to create one; the developer adds it once.
  async findStoreApp(bundleId: string): Promise<{ id: string; name: string } | null> {
    const res = await this.call<{ data: Resource<{ bundleId: string; name: string }>[] }>("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=200`);
    const app = res.data.find((a) => a.attributes.bundleId === bundleId);
    return app ? { id: app.id, name: app.attributes.name } : null;
  }

  // An App Store profile for TestFlight builds, made again when it lacks the certificate.
  async ensureStoreProfile(name: string, bundleIdRes: string, certificateId: string, profileType = "IOS_APP_STORE"): Promise<{ id: string; uuid: string; profileContent: string; expirationDate: string }> {
    const old = await this.findProfileByName(name);
    const certs = asList(old?.relationships?.certificates?.data).map((c) => c.id);
    const attrs = old?.attributes as { profileType?: string; profileState?: string } | undefined;
    if (old && certs.includes(certificateId) && attrs?.profileType === profileType && attrs?.profileState !== "INVALID" && Date.parse(old.attributes.expirationDate) > this.deps.now().getTime()) {
      return { id: old.id, uuid: old.attributes.uuid, profileContent: old.attributes.profileContent, expirationDate: old.attributes.expirationDate };
    }
    if (old) await this.call("DELETE", `/v1/profiles/${old.id}`);
    const res = await this.call<{ data: Resource<{ uuid: string; profileContent: string; expirationDate: string }> }>("POST", "/v1/profiles", {
      data: {
        type: "profiles",
        attributes: { name, profileType },
        relationships: { bundleId: { data: { type: "bundleIds", id: bundleIdRes } }, certificates: { data: [{ type: "certificates", id: certificateId }] } },
      },
    });
    return { id: res.data.id, ...res.data.attributes };
  }

  // The external beta group friends join through its public link; created with the link switched on.
  async ensureBetaGroup(storeAppId: string, name: string): Promise<{ id: string; publicLink: string | null }> {
    const res = await this.call<{ data: Resource<{ name: string; isInternalGroup: boolean; publicLinkEnabled: boolean; publicLink: string | null }>[] }>("GET", `/v1/apps/${storeAppId}/betaGroups?limit=200`);
    let group = res.data.find((g) => g.attributes.name === name && !g.attributes.isInternalGroup);
    if (!group) {
      const made = await this.call<{ data: Resource<{ name: string; isInternalGroup: boolean; publicLinkEnabled: boolean; publicLink: string | null }> }>("POST", "/v1/betaGroups", {
        data: { type: "betaGroups", attributes: { name, publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true }, relationships: { app: { data: { type: "apps", id: storeAppId } } } },
      });
      group = made.data;
    } else if (!group.attributes.publicLinkEnabled) {
      const updated = await this.call<{ data: Resource<{ name: string; isInternalGroup: boolean; publicLinkEnabled: boolean; publicLink: string | null }> }>("PATCH", `/v1/betaGroups/${group.id}`, {
        data: { type: "betaGroups", id: group.id, attributes: { publicLinkEnabled: true, publicLinkLimitEnabled: false } },
      });
      group = updated.data;
    }
    return { id: group.id, publicLink: group.attributes.publicLink ?? null };
  }

  async betaGroupLink(groupId: string): Promise<string | null> {
    const res = await this.call<{ data: Resource<{ publicLink: string | null }> }>("GET", `/v1/betaGroups/${groupId}`);
    return res.data.attributes.publicLink ?? null;
  }

  async iosOnMac(groupId: string): Promise<boolean | null> {
    const res = await this.call<{ data: Resource<{ iosBuildsAvailableForAppleSiliconMac?: boolean }> }>("GET", `/v1/betaGroups/${groupId}?fields[betaGroups]=iosBuildsAvailableForAppleSiliconMac`);
    const value = res.data.attributes.iosBuildsAvailableForAppleSiliconMac;
    return typeof value === "boolean" ? value : null;
  }

  // Who Apple's beta review contacts, and the description testers see; both are required for review.
  async setBetaReviewDetails(storeAppId: string, contact: { firstName: string; lastName: string; email: string; phone: string }, notes: string): Promise<void> {
    const res = await this.call<{ data: Resource }>("GET", `/v1/apps/${storeAppId}/betaAppReviewDetail`);
    await this.call("PATCH", `/v1/betaAppReviewDetails/${res.data.id}`, {
      data: {
        type: "betaAppReviewDetails",
        id: res.data.id,
        attributes: { contactFirstName: contact.firstName, contactLastName: contact.lastName, contactEmail: contact.email, contactPhone: contact.phone, demoAccountRequired: false, notes: notes.slice(0, 4000) },
      },
    });
  }

  // Beta review needs a description in every beta localization, and one in the app's primary language.
  // Returns the locales found, for error messages.
  async setBetaDescription(storeAppId: string, text: { description: string; feedbackEmail?: string }): Promise<string> {
    const app = await this.call<{ data: Resource<{ primaryLocale?: string }> }>("GET", `/v1/apps/${storeAppId}?fields[apps]=primaryLocale`);
    const primary = app.data.attributes.primaryLocale ?? "en-US";
    const res = await this.call<{ data: Resource<{ locale: string; feedbackEmail?: string | null }>[] }>("GET", `/v1/apps/${storeAppId}/betaAppLocalizations?limit=50`);
    const feedbackEmail = text.feedbackEmail ?? res.data.find((l) => l.attributes.feedbackEmail)?.attributes.feedbackEmail ?? undefined;
    const attributes = { description: text.description.slice(0, 4000), ...(feedbackEmail ? { feedbackEmail } : {}) };
    for (const l of res.data) await this.call("PATCH", `/v1/betaAppLocalizations/${l.id}`, { data: { type: "betaAppLocalizations", id: l.id, attributes } });
    if (!res.data.some((l) => l.attributes.locale === primary)) {
      await this.call("POST", "/v1/betaAppLocalizations", { data: { type: "betaAppLocalizations", attributes: { locale: primary, ...attributes }, relationships: { app: { data: { type: "apps", id: storeAppId } } } } });
    }
    return `primary ${primary}; beta localizations before: ${res.data.map((l) => l.attributes.locale).join(", ") || "none"}`;
  }

  // Reserves an upload; the workflow sends the bytes straight to Apple with the returned operations.
  async reserveBuildUpload(storeAppId: string, version: string, buildNumber: string, fileName: string, fileSize: number, platform: ApplePlatform = "ios"): Promise<{ uploadId: string; fileId: string; operations: UploadOperation[] }> {
    const upload = await this.call<{ data: Resource }>("POST", "/v1/buildUploads", {
      data: { type: "buildUploads", attributes: { cfBundleShortVersionString: version, cfBundleVersion: buildNumber, platform: applePlatformName(platform) }, relationships: { app: { data: { type: "apps", id: storeAppId } } } },
    });
    const file = await this.call<{ data: Resource<{ uploadOperations?: UploadOperation[] }> }>("POST", "/v1/buildUploadFiles", {
      data: { type: "buildUploadFiles", attributes: { assetType: "ASSET", fileName, fileSize, uti: platform === "macos" ? "com.apple.pkg" : "com.apple.ipa" }, relationships: { buildUpload: { data: { type: "buildUploads", id: upload.data.id } } } },
    });
    return { uploadId: upload.data.id, fileId: file.data.id, operations: file.data.attributes.uploadOperations ?? [] };
  }

  async commitBuildUpload(fileId: string, md5: string): Promise<void> {
    await this.call("PATCH", `/v1/buildUploadFiles/${fileId}`, {
      data: { type: "buildUploadFiles", id: fileId, attributes: { uploaded: true, sourceFileChecksums: { file: { algorithm: "MD5", hash: md5 } } } },
    });
  }

  async buildUploadState(uploadId: string): Promise<{ state: string; errors: string[] }> {
    const res = await this.call<{ data: Resource<{ state?: { state?: string; errors?: { description?: string; code?: string }[] } }> }>("GET", `/v1/buildUploads/${uploadId}`);
    const st = res.data.attributes.state;
    return { state: st?.state ?? "UNKNOWN", errors: (st?.errors ?? []).map((e) => e.description ?? e.code ?? "error") };
  }

  async findBuild(storeAppId: string, version: string, buildNumber: string, platform: ApplePlatform = "ios"): Promise<{ id: string; processingState: string; usesNonExemptEncryption: boolean | null; expirationDate: string | null; expired: boolean } | null> {
    const res = await this.call<{ data: Resource<{ processingState: string; usesNonExemptEncryption: boolean | null; expirationDate: string | null; expired?: boolean }>[] }>(
      "GET",
      `/v1/builds?filter[app]=${storeAppId}&filter[version]=${encodeURIComponent(buildNumber)}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[preReleaseVersion.platform]=${applePlatformName(platform)}&limit=1`,
    );
    const b = res.data[0];
    return b
      ? { id: b.id, processingState: b.attributes.processingState, usesNonExemptEncryption: b.attributes.usesNonExemptEncryption ?? null, expirationDate: b.attributes.expirationDate ?? null, expired: b.attributes.expired === true }
      : null;
  }

  async maximumBuildNumber(storeAppId: string, version: string, platform: ApplePlatform): Promise<number> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
      const base = new URL(this.env.APPLE_API_BASE);
      const query = new URLSearchParams({ "filter[app]": storeAppId, "filter[preReleaseVersion.version]": version, "filter[preReleaseVersion.platform]": applePlatformName(platform), include: "app,preReleaseVersion", "fields[builds]": "version,app,preReleaseVersion", "fields[preReleaseVersions]": "version,platform", limit: "200" });
      let next: string | null = `/v1/builds?${query}`;
      let maximum = 0;
      let seen = 0;
      const visited = new Set<string>();
      for (let page = 0; next && page < 10; page++) {
        const url: URL = new URL(next, base);
        if (url.origin !== base.origin || url.pathname !== "/v1/builds" || url.username || url.password || visited.has(url.href)) throw new Error("Apple returned an invalid build pagination link.");
        visited.add(url.href);
        for (const [key, value] of query) url.searchParams.set(key, value);
        const result: BuildNumberPage = await this.call<BuildNumberPage>("GET", `${url.pathname}${url.search}`, undefined, controller.signal);
        if (!Array.isArray(result.data) || result.data.length > 200) throw new Error("Apple returned an invalid builds page.");
        for (const build of result.data) {
          const app = asList(build.relationships?.app?.data)[0];
          const releaseId = asList(build.relationships?.preReleaseVersion?.data)[0];
          const release = result.included?.find((item) => item.type === "preReleaseVersions" && item.id === releaseId?.id);
          if (app?.id !== storeAppId || release?.attributes.version !== version || release.attributes.platform !== applePlatformName(platform)) throw new Error("Apple build scope could not be verified.");
          maximum = Math.max(maximum, numericBuildNumber(build.attributes.version));
        }
        seen += result.data.length;
        next = result.links?.next ?? null;
        if (next !== null && typeof next !== "string") throw new Error("Apple returned an invalid build pagination link.");
        if (!next && typeof result.meta?.paging?.total === "number" && result.meta.paging.total > seen) throw new Error("Apple build pagination was incomplete.");
      }
      if (next) throw new Error("Apple build pagination exceeded ten pages.");
      return maximum;
    };
    try {
      return await Promise.race([scan(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Apple build lookup timed out.")); }, 8000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  // Apple's export compliance answer for one build.
  async setBuildEncryption(buildId: string, usesNonExemptEncryption: boolean): Promise<void> {
    await this.call("PATCH", `/v1/builds/${buildId}`, { data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption } } });
  }

  // Where the build stands for external testers (ExternalBetaState), and the record that holds it.
  async betaDetail(buildId: string): Promise<{ id: string; externalBuildState: string; autoNotifyEnabled: boolean }> {
    const res = await this.call<{ data: Resource<{ externalBuildState?: string; autoNotifyEnabled?: boolean }> }>("GET", `/v1/builds/${buildId}/buildBetaDetail`);
    return { id: res.data.id, externalBuildState: res.data.attributes.externalBuildState ?? "UNKNOWN", autoNotifyEnabled: res.data.attributes.autoNotifyEnabled === true };
  }

  // Apple then makes the build available to its external groups as soon as beta review approves it.
  async setAutoNotify(betaDetailId: string): Promise<void> {
    await this.call("PATCH", `/v1/buildBetaDetails/${betaDetailId}`, { data: { type: "buildBetaDetails", id: betaDetailId, attributes: { autoNotifyEnabled: true } } });
  }

  // The "Notify Testers" step of App Store Connect: makes an approved build available to its groups.
  async notifyTesters(buildId: string): Promise<void> {
    await this.call("POST", "/v1/buildBetaNotifications", { data: { type: "buildBetaNotifications", relationships: { build: { data: { type: "builds", id: buildId } } } } });
  }

  // The newest build that has not expired, to know when the next one is due.
  async latestLiveBuild(storeAppId: string, platform: ApplePlatform = "ios"): Promise<{ id: string; expirationDate: string | null } | null> {
    const res = await this.call<{ data: Resource<{ expirationDate: string | null }>[] }>("GET", `/v1/builds?filter[app]=${storeAppId}&filter[preReleaseVersion.platform]=${applePlatformName(platform)}&filter[expired]=false&sort=-uploadedDate&limit=1`);
    const b = res.data[0];
    return b ? { id: b.id, expirationDate: b.attributes.expirationDate ?? null } : null;
  }

  async addBuildToGroup(groupId: string, buildId: string): Promise<void> {
    await this.call("POST", `/v1/betaGroups/${groupId}/relationships/builds`, { data: [{ type: "builds", id: buildId }] });
  }

  async setWhatsNew(buildId: string, whatsNew: string): Promise<void> {
    const res = await this.call<{ data: Resource<{ locale: string }>[] }>("GET", `/v1/builds/${buildId}/betaBuildLocalizations?limit=50`);
    const existing = res.data[0];
    const attributes = { whatsNew: whatsNew.slice(0, 4000) };
    if (existing) await this.call("PATCH", `/v1/betaBuildLocalizations/${existing.id}`, { data: { type: "betaBuildLocalizations", id: existing.id, attributes } });
    else await this.call("POST", "/v1/betaBuildLocalizations", { data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", ...attributes }, relationships: { build: { data: { type: "builds", id: buildId } } } } });
  }

  async submitForBetaReview(buildId: string): Promise<void> {
    await this.call("POST", "/v1/betaAppReviewSubmissions", { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: buildId } } } } });
  }

  // An Apple Distribution certificate signs the iPhone and iPad builds that go to TestFlight.
  async createDistributionCertificate(csrPem: string, certificateType: "DISTRIBUTION" | "MAC_INSTALLER_DISTRIBUTION" = "DISTRIBUTION"): Promise<{ id: string; name: string; serialNumber: string; certificateContent: string; expirationDate: string | null }> {
    const res = await this.call<{ data: Resource<{ name: string; serialNumber: string; certificateContent: string; expirationDate?: string }> }>("POST", "/v1/certificates", {
      data: { type: "certificates", attributes: { certificateType, csrContent: csrPem } },
    });
    const a = res.data.attributes;
    return { id: res.data.id, name: a.name, serialNumber: a.serialNumber, certificateContent: a.certificateContent, expirationDate: a.expirationDate ?? null };
  }
}

export interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: { name: string; value: string }[];
}

export class AppleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
