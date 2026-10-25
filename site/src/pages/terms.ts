// Terms of use and data statement, shown at sign-up and reachable from the profile.
import { TERMS_VERSION } from "@my/store-shared";
import { api, whoAmI, type Me } from "../api.js";
import { html, mount, type Raw } from "../html.js";
import { navigate } from "../nav.js";
import { setTheme } from "../theme.js";
import { callout, icon, toast, wireImages } from "../ui.js";
import { storeFrame } from "./public.js";

export { TERMS_VERSION };

export function termsBody(): Raw {
  return html`
    <article class="story terms">
      <h1 style="font-size:34px">Terms of use and data statement</h1>
      <p class="muted">Version ${TERMS_VERSION}. Plain words on purpose. ourapps is operated by Level N Ltd.</p>

      <h2>1. What ourapps is</h2>
      <p>ourapps is a private installer. Developers register apps they built, create share links, and friends install from those links. It is not an app store: there is no catalogue, no search, no review of apps, and no transaction between you and the people who install.</p>

      <h2>2. Who the terms apply to</h2>
      <p>These terms are between Level N Ltd and you, the developer who signs in. Friends who open a share link do not sign in and hold no account; what the service records about them is in section 4.</p>

      <h2>3. What we hold about you and why</h2>
      <table class="table">
        <tr><th>Data</th><th>Why we hold it</th><th>Where it goes</th></tr>
        <tr><td>GitHub id, login, display name</td><td>To identify your account when you sign in; sign-in reads your public profile only</td><td>Display name and page address are shown to friends on install pages</td></tr>
        <tr><td>GitHub token (encrypted)</td><td>To read release assets from your repositories and to ask them for fresh builds</td><td>Sent only to api.github.com, only for repositories you named</td></tr>
        <tr><td>App Store Connect API key and team id (encrypted)</td><td>To create your iPhone signing certificate, App IDs and provisioning profiles, and to upload builds to TestFlight and send them to your friends, on your behalf</td><td>Sent only to api.appstoreconnect.apple.com, when you set up signing or TestFlight, when a workflow uploads a build, and when the service looks after TestFlight builds</td></tr>
        <tr><td>Private keys of the Apple Distribution and Mac Installer Distribution certificates the service creates for you (encrypted), with the certificates</td><td>So your apps' release workflows can sign Apple apps and Mac installation packages without Apple secrets in the repositories</td><td>Given only to a release workflow that presents one of your apps' build tokens; installer signing material is returned only for Mac builds</td></tr>
        <tr><td>App listings (name, text, image addresses, repository name, bundle ID) and their TestFlight set-up</td><td>To build install pages and read releases</td><td>Shown to whoever holds a share link; details only on your public page when you switch it on</td></tr>
        <tr><td>Share links</td><td>To let friends reach an install page and to let you revoke access</td><td>Known to whoever you send them to</td></tr>
        <tr><td>API keys (hashed), sessions (hashed), build tokens (hashed)</td><td>To let you, your agents and your repositories act on your account</td><td>Nowhere; we hold hashes only</td></tr>
        <tr><td>Audit log (event, short detail, country of the request)</td><td>So you can see what happened on your account</td><td>Shown only to you</td></tr>
      </table>
      <p>We do not sell, share or analyse this information for any purpose other than running the service for you. No advertising, no analytics, no tracking of friends. Level N Ltd staff do not read your credentials; they are encrypted with a key that exists only in the service's secret store, and the service decrypts a field only at the moment it is needed.</p>

      <h2>4. What we hold about your friends</h2>
      <p>Nothing. Friends who install on iPhone or iPad deal with Apple directly through TestFlight, and Android and web installs record nothing about the friend. Install pages set no cookies and carry no analytics.</p>

      <h2>5. Your responsibilities</h2>
      <ul class="bullets">
        <li>You are responsible for the apps you share: what they do, what they collect, and that you have the right to the code, the images and the names in them. Write the privacy summary on each app honestly; friends rely on it.</li>
        <li>Share links are private by obscurity. Send them to people you mean to, and revoke them when you change your mind.</li>
        <li>Apple's and Google's developer agreements apply to you, not to us. In particular, TestFlight builds go through Apple's beta review.</li>
        <li>For each TestFlight build the service answers Apple's export compliance question for you: the app uses no encryption, or only encryption exempt from export compliance requirements. Share through the service only apps for which that is true.</li>
        <li>Keep your GitHub and Apple accounts secure; the service can only be as safe as the sign-in in front of it.</li>
        <li>Do not use the service to distribute anything unlawful, deceptive or harmful, or to reach people who did not ask for it.</li>
      </ul>

      <h2>6. Keeping it secure</h2>
      <p>Credentials are encrypted per account with keys derived from a secret that lives only in the service's secret store; tokens and sessions are stored as keyed hashes; credential changes require a browser session; API keys have scopes and expiry; every security event is logged and shown to you. The details are in the <a href="/dev/guide#security">guide</a>. If we learn of a breach affecting your data we will tell you through the email on your GitHub account without undue delay and say what was affected and what we did.</p>

      <h2>7. Removing your data</h2>
      <p>Credentials can be removed one by one in Settings. Deleting an app removes its links and its TestFlight records. Deleting your account (Settings, Profile) removes everything we hold about you at once; apps already installed through TestFlight keep working until their build expires, which we cannot change. The signing certificate, the App Store profiles and the apps in App Store Connect remain on your Apple account; remove them there.</p>

      <h2>8. The service itself</h2>
      <p>ourapps is provided free and as is. We aim to keep it running and to give notice before any withdrawal, but we make no promise of availability and accept no liability for loss arising from its use, to the extent the law allows. We may change these terms; when we do, you are asked to accept the current version the next time you open the console, and the version you accepted is shown in your profile.</p>

      <h2>9. Contact</h2>
      <p>Level N Ltd. Questions about these terms or about your data: use the contact details on <a href="https://www.level-n.com" target="_blank" rel="noopener">level-n.com</a>. Security problems: report them privately at <a href="https://github.com/george-mcintyre/ourapps/security/advisories/new" target="_blank" rel="noopener">github.com/george-mcintyre/ourapps/security</a>. Please do not post personal details or security problems in public issues.</p>
    </article>
  `;
}

export async function termsPage(root: HTMLElement): Promise<void> {
  setTheme("store", "Terms of use", true);
  const me = await whoAmI();
  const accepted = me?.developer.termsAcceptedVersion === TERMS_VERSION;
  mount(
    root,
    storeFrame(
      html`
        <div style="max-width:760px;margin:0 auto">
          ${me && !accepted ? acceptCard(me) : ""}
          ${termsBody()}
          ${me && accepted ? html`<p class="small muted mt">You accepted version ${me.developer.termsAcceptedVersion} on ${new Date(me.developer.termsAcceptedAt!).toLocaleString()}. <a href="/dev/settings">Profile</a></p>` : ""}
        </div>
      `,
      { me },
    ),
  );
  wireImages(root);
  wireAccept(root);
}

function acceptCard(me: Me): Raw {
  const changed = me.developer.termsAcceptedVersion !== null;
  return html`
    <div class="card pad-l mt" style="border-color:var(--accent)">
      <h2 style="margin-top:0">${changed ? "Accept the current terms" : "Before you start"}</h2>
      <p class="muted">${changed ? `You accepted version ${me.developer.termsAcceptedVersion}; version ${TERMS_VERSION} is current. Please read and accept it.` : "Read these terms once; they say what we hold about you and your friends and why. The console opens as soon as you accept."}</p>
      <label class="check mt"><input type="checkbox" id="agree" /> <span>I have read the terms and the data statement and I accept them.</span></label>
      <div class="form-actions"><button class="btn lg" id="accept" disabled>Accept and continue</button><form method="post" action="/api/auth/logout" style="display:inline"><button class="btn secondary" type="submit">Sign out instead</button></form></div>
      <div id="error" class="mt-s"></div>
    </div>
  `;
}

function wireAccept(root: HTMLElement): void {
  const box = root.querySelector<HTMLInputElement>("#agree");
  const btn = root.querySelector<HTMLButtonElement>("#accept");
  if (!box || !btn) return;
  box.onchange = () => (btn.disabled = !box.checked);
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api("POST", "/api/dev/terms", { version: TERMS_VERSION });
      await whoAmI(true);
      toast("Thank you");
      navigate("/dev");
    } catch (err) {
      btn.disabled = false;
      root.querySelector("#error")!.innerHTML = callout("bad", html`<p>${err instanceof Error ? err.message : String(err)}</p>`).html;
    }
  };
}

export function termsPending(me: Me | null): boolean {
  return Boolean(me && me.authVia === "session" && me.developer.termsAcceptedVersion !== TERMS_VERSION);
}

export { icon };
