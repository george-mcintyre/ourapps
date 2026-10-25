// Technical reference: supported app types, where everything runs, and implementation specifics.
import { whoAmI } from "../api.js";
import { html, mount, raw, type Raw } from "../html.js";
import { setTheme } from "../theme.js";
import { callout, icon, wireCopy, wireImages } from "../ui.js";
import { COPYRIGHT } from "./public.js";
import { mountShell } from "./shell.js";
import { termsPending } from "./terms.js";

const s = (v: string) => `style="${v}"`;

// Architecture diagram drawn in the console's own palette; replaced by /reference/architecture.png when present.
function architectureSvg(): Raw {
  const card = (x: number, y: number, w: number, h: number, title: string, sub: string, accent = false) => `
    <g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" ${s(`fill:var(${accent ? "--accent-soft" : "--surface"});stroke:var(${accent ? "--accent" : "--line-2"});stroke-width:1`)} />
      <text x="${x + 14}" y="${y + 24}" ${s("fill:var(--text);font-weight:700;font-size:13px")}>${title}</text>
      <text x="${x + 14}" y="${y + 42}" ${s("fill:var(--text-2);font-size:11.5px")}>${sub}</text>
    </g>`;
  const label = (x: number, y: number, text: string, color = "--text-3", anchor = "start") => `<text x="${x}" y="${y}" text-anchor="${anchor}" ${s(`fill:var(${color});font-size:11px;font-weight:600`)}>${text}</text>`;
  const install = (d: string) => `<path d="${d}" ${s("fill:none;stroke:var(--accent);stroke-width:1.8;stroke-dasharray:6 5")} marker-end="url(#ah-install)" />`;
  const run = (d: string) => `<path d="${d}" ${s("fill:none;stroke:var(--ok);stroke-width:2.2")} marker-end="url(#ah-run)" />`;
  return raw(`
  <svg viewBox="0 0 1000 640" role="img" aria-label="How a typical app with its own API and database is hosted and installed through ourapps" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font)">
    <defs>
      <marker id="ah-install" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" ${s("fill:var(--accent)")} /></marker>
      <marker id="ah-run" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" ${s("fill:var(--ok)")} /></marker>
    </defs>

    ${label(60, 34, "FRIENDS' DEVICES")}
    ${card(60, 50, 190, 64, "iPhone or iPad", "native app (.ipa)")}
    ${card(60, 134, 190, 64, "Android phone", "native app (.apk)")}
    ${card(60, 218, 190, 64, "Any browser", "web app, on the home screen")}

    <rect x="320" y="40" width="290" height="352" rx="16" ${s("fill:var(--accent-soft);stroke:var(--accent);stroke-width:1.2")} />
    <text x="340" y="68" ${s("fill:var(--text);font-weight:800;font-size:15px")}>ourapps.app</text>
    <text x="340" y="86" ${s("fill:var(--accent);font-size:11.5px;font-weight:600")}>distribution only</text>
    ${card(336, 100, 258, 52, "Install page", "/l/&lt;link&gt;: listing, steps, QR")}
    ${card(336, 162, 258, 52, "Signed downloads", "/dl/&#8230;: streams .apk and images")}
    ${card(336, 224, 258, 52, "TestFlight", "uploads, friends' group, fresh builds")}
    ${card(336, 286, 258, 52, "iPhone signing", "certificate, App Store profile")}
    <text x="465" y="372" text-anchor="middle" ${s("fill:var(--text-2);font-size:11.5px;font-style:italic")}>no app code, API or database runs here</text>

    <rect x="680" y="40" width="300" height="214" rx="16" ${s("fill:var(--surface-2);stroke:var(--line-2);stroke-width:1")} />
    <text x="700" y="68" ${s("fill:var(--text);font-weight:800;font-size:15px")}>Your GitHub repository</text>
    ${card(696, 82, 268, 52, "Actions", "build, sign and deploy each release")}
    <rect x="696" y="144" width="268" height="94" rx="12" ${s("fill:var(--surface);stroke:var(--line-2);stroke-width:1")} />
    <text x="710" y="168" ${s("fill:var(--text);font-weight:700;font-size:13px")}>Releases</text>
    <text x="710" y="190" ${s("fill:var(--text-2);font-size:11.5px")}>my-app.json · CHANGELOG.md</text>
    <text x="710" y="208" ${s("fill:var(--text-2);font-size:11.5px")}>.apk · icon · screenshots</text>

    <rect x="680" y="270" width="300" height="72" rx="16" ${s("fill:var(--ok-soft);stroke:var(--ok);stroke-width:1.2")} />
    <text x="696" y="296" ${s("fill:var(--text);font-weight:700;font-size:13px")}>Your Cloudflare account</text>
    <text x="696" y="316" ${s("fill:var(--text-2);font-size:11.5px")}>web app files, served free</text>

    ${card(680, 360, 300, 64, "Apple App Store Connect API", "certificate, profiles, TestFlight")}

    <rect x="20" y="460" width="960" height="124" rx="16" ${s("fill:var(--ok-soft);stroke:var(--ok);stroke-width:1.2")} />
    <text x="40" y="488" ${s("fill:var(--text);font-weight:800;font-size:15px")}>Your backend, hosted wherever you like</text>
    <text x="40" y="506" ${s("fill:var(--text-2);font-size:11.5px")}>Cloudflare Workers, Fly.io, Render, Supabase, a VPS, a Mac mini at home</text>
    ${card(300, 520, 220, 52, "REST or WebSocket API", "HTTPS, tokens, CORS for the web")}
    ${card(600, 520, 220, 52, "Database and files", "only your API talks to it")}
    <path d="M520,546 L598,546" ${s("fill:none;stroke:var(--ok);stroke-width:2")} />

    ${install("M320,126 C290,126 280,82 252,82")}
    ${install("M320,188 C290,188 280,166 252,166")}
    ${install("M320,134 C292,134 284,250 252,250")}
    ${install("M696,200 L596,188")}
    ${install("M596,250 C640,250 640,392 678,392")}
    ${install("M596,236 C650,236 650,104 694,104")}
    ${install("M596,312 C650,312 660,124 694,124")}
    ${install("M964,108 C996,108 996,306 982,306")}
    ${label(626, 98, "fresh build", "--accent")}
    ${label(626, 182, "files", "--accent")}
    ${label(612, 340, "certificate, profile", "--accent")}
    ${run("M155,282 L155,438 L830,438 L830,346")}
    ${label(420, 432, "opens the web app", "--ok")}

    <path d="M60,82 L40,82 L40,456" ${s("fill:none;stroke:var(--ok);stroke-width:2.2")} marker-end="url(#ah-run)" />
    <path d="M60,166 L40,166" ${s("fill:none;stroke:var(--ok);stroke-width:2.2")} />
    <path d="M60,250 L40,250" ${s("fill:none;stroke:var(--ok);stroke-width:2.2")} />
    <text x="30" y="420" transform="rotate(-90 30 420)" ${s("fill:var(--ok);font-size:11px;font-weight:700")}>every launch: straight to your API</text>

    <line x1="40" y1="612" x2="76" y2="612" ${s("stroke:var(--accent);stroke-width:1.8;stroke-dasharray:6 5")} />
    ${label(84, 616, "installing and updating", "--text-2")}
    <line x1="260" y1="612" x2="296" y2="612" ${s("stroke:var(--ok);stroke-width:2.2")} />
    ${label(304, 616, "using the app", "--text-2")}
  </svg>`);
}

// A generated illustration (WebP, PNG fallback) that opens full size; removed when the file is missing.
export function diagram(file: string, alt: string): Raw {
  const base = file.replace(/\.png$/, "");
  return html`<a class="figure-link" href="/reference/${base}.png" target="_blank" rel="noopener" title="Open full size"><picture><source srcset="/reference/${base}.webp" type="image/webp" /><img class="ref-figure" src="/reference/${base}.png" alt="${alt}" width="1672" height="941" data-optional loading="lazy" /></picture><span class="figure-hint">Open full size</span></a>`;
}

function optionalFigure(file: string, alt: string): Raw {
  return diagram(file, alt);
}

interface Topology {
  id: string;
  title: string;
  file: string;
  summary: string;
  parts: [string, string][];
}

const TOPOLOGIES: Topology[] = [
  {
    id: "topo-typical",
    title: "App with its own API and database, in three flavours",
    file: "architecture.png",
    summary: "The common case: one backend, three clients. ourapps installs the clients; the clients talk to your API directly.",
    parts: [
      ["Clients", "SwiftUI .ipa, Kotlin .apk and a web build, all from one release workflow"],
      ["ourapps", "install pages, iPhone signing and TestFlight, signed downloads"],
      ["You host", "the API and the database anywhere with HTTPS; the web build on your Cloudflare account"],
    ],
  },
  {
    id: "topo-offline",
    title: "Offline app, no backend",
    file: "offline.png",
    summary: "A tool or game that keeps everything on the phone. No server to run: ourapps is involved only at install and update time, and the web version is plain files on your Cloudflare account.",
    parts: [
      ["Clients", "native or web; data in the phone's storage"],
      ["ourapps", "install and update only"],
      ["You host", "only the web version's files, free on Cloudflare"],
    ],
  },
  {
    id: "topo-web",
    title: "Static web app on your own Cloudflare account",
    file: "web-cloudflare.png",
    summary: "A Vite, Flutter web or similar build that the release workflow deploys to your free Cloudflare account as a Worker with files only. The install page links to it; ourapps never serves or proxies it.",
    parts: [
      ["Clients", "any browser, added to the home screen"],
      ["ourapps", "the install page and the link"],
      ["You host", "the files, free on Cloudflare, and your API if there is one"],
    ],
  },
  {
    id: "topo-web-link",
    title: "Web app with its own server, hosted elsewhere",
    file: "web-link.png",
    summary: "A server-rendered site, or one already on Vercel, Cloudflare Pages or your own server. The install page links to it; ourapps does not proxy it.",
    parts: [
      ["Clients", "any browser"],
      ["ourapps", "the install page and the link, nothing else"],
      ["You host", "the whole web app"],
    ],
  },
  {
    id: "topo-unity",
    title: "Unity or Godot game in the browser",
    file: "unity-web.png",
    summary: "An engine's web export deployed to your Cloudflare account without pre-compression, with isolation headers from a _headers file for threaded builds.",
    parts: [
      ["Clients", "desktop and recent mobile browsers"],
      ["ourapps", "the install page; serves the build only for web.zip apps"],
      ["You host", "the build on your Cloudflare account, and a multiplayer or leaderboard server if the game needs one"],
    ],
  },
  {
    id: "topo-realtime",
    title: "Realtime multiplayer across all three",
    file: "realtime.png",
    summary: "Native and web players at the same table over WebSockets. The game server is yours; installs come through ourapps, and the web client loads from your Cloudflare account.",
    parts: [
      ["Clients", "iPhone, Android and browser players together"],
      ["ourapps", "installs, iPhone signing, update checks"],
      ["You host", "the game server and its state; the web client's files on your Cloudflare account"],
    ],
  },
  {
    id: "topo-crossplatform",
    title: "One codebase, three builds",
    file: "cross-platform.png",
    summary: "Flutter, React Native, Capacitor or .NET MAUI produce the .ipa, the .apk and often a web build from one source. The .ipa goes to TestFlight through ourapps, one release carries the .apk, and the web build is deployed to your Cloudflare account.",
    parts: [
      ["Clients", "the same app on every device"],
      ["ourapps", "one listing, three install paths"],
      ["You host", "whatever the app calls"],
    ],
  },
  {
    id: "topo-iphone",
    title: "iPhone install through TestFlight, step by step",
    file: "testflight-sequence.png",
    summary: "From a tagged release to the app on a friend's iPhone: signing from ourapps, the upload through ourapps, Apple's processing and beta review, the invitation link, TestFlight's Install.",
    parts: [
      ["Friend", "TestFlight app, Open the invitation, Accept, Install"],
      ["ourapps", "signing, upload, friends' group, beta review, fresh build before expiry"],
      ["You", "add the app once in App Store Connect; push a tag"],
    ],
  },
];

function body(): Raw {
  return html`
    <div class="guide">
      <nav class="toc">
        <a href="#types">Supported app types</a>
        <a href="#where">Where everything runs</a>
        <a href="#ios">Native iPhone and iPad</a>
        <a href="#android">Native Android</a>
        <a href="#desktop">Mac, Windows and Apple TV</a>
        <a href="#web">Web apps</a>
        <a href="#engines">Engines and frameworks</a>
        <a href="#backend">Your backend</a>
        <a href="#limits">Limits</a>
        <a href="#topologies">Diagrams by app type</a>
        <hr /><a href="/agents.md">agents.md</a><a href="/contract.md">contract.md</a><a href="/dev/guide">Guide</a>
      </nav>
      <article class="reference">
        <section id="types">
          <h2>Supported app types</h2>
          <table class="table">
            <tr><th>Kind</th><th>Examples</th><th>How it reaches people</th><th>Status</th></tr>
            <tr><td>Native iPhone and iPad</td><td>Swift, SwiftUI, UIKit, Objective-C</td><td>App Store-signed .ipa on TestFlight; friends install with Apple's TestFlight app</td><td><span class="pill ok">supported</span> 10,000 people per app; Apple's beta review</td></tr>
            <tr><td>Native Android</td><td>Kotlin, Java, Jetpack Compose</td><td>Signed universal .apk, direct download</td><td><span class="pill ok">supported</span> no device limit</td></tr>
            <tr><td>Mac and Windows</td><td>Native or wrapped desktop apps</td><td>Mac .dmg and Windows .exe downloads with named architecture choices</td><td><span class="pill ok">supported</span> system security policy applies</td></tr>
            <tr><td>Mac and Apple TV TestFlight</td><td>macOS and tvOS builds</td><td>Separate platform setup, builds and ready invitations</td><td><span class="pill ok">supported</span> Apple's beta review</td></tr>
            <tr><td>Cross-platform native</td><td>Flutter, React Native and Expo, .NET MAUI, Kotlin Multiplatform, Capacitor, Cordova, Unity and Godot mobile builds</td><td>As iPhone/iPad and Android above</td><td><span class="pill ok">supported</span></td></tr>
            <tr><td>Static web app or PWA</td><td>Vite with React, Vue, Svelte or Solid; Angular; Astro; Flutter web; Next.js static export</td><td>Deployed by your workflow to your own free Cloudflare account; the install page opens it</td><td><span class="pill ok">supported</span> 20,000 files, 25 MB per file</td></tr>
            <tr><td>Web games</td><td>Unity Web, Godot 4 web export, Phaser, PlayCanvas, Three.js, Babylon.js</td><td>Deployed to your Cloudflare account without pre-compression, with a _headers file</td><td><span class="pill warn">supported</span> phone performance varies</td></tr>
            <tr><td>Web app with its own server</td><td>Next.js with server rendering, Remix, Rails, Django, Laravel</td><td>Hosted by you; the install page links to it</td><td><span class="pill ok">supported as a link</span></td></tr>
            <tr><td>Backends</td><td>REST, GraphQL, WebSocket servers, databases, file storage</td><td>Hosted by you; apps call them directly</td><td><span class="pill">never hosted by ourapps</span></td></tr>
          </table>
          <h3>Not supported</h3>
          <ul class="bullets">
            <li>Running server code, APIs or databases on ourapps. It distributes apps; it does not host their logic.</li>
            <li>Native Linux, Apple Watch and Vision Pro install flows.</li>
            <li>Android App Bundles (.aab) as they are: phones cannot install them. Convert to a universal .apk (<a href="#android">how</a>).</li>
            <li>iPhone apps that skip Apple's beta review: every iPhone build reaches friends through TestFlight.</li>
            <li>Features that need App Store distribution, such as real in-app purchases.</li>
          </ul>
        </section>

        <section id="desktop">
          <h2>Mac, Windows and Apple TV</h2>
          <p><code>install.macos.packages</code> and <code>install.windows.packages</code> list release downloads. Each package declares its address, format (.dmg or .exe), architectures (<code>arm64</code>, <code>x64</code>), minimum system and signed or unsigned status. Mac packages also declare notarization. The page offers each package by name; it does not infer the Mac chip from the browser.</p>
          <p>Mac: open the .dmg and drag the app to Applications. Quit and replace that app to update. Windows: run the .exe installer; run the new installer to update and use Installed apps to uninstall. System security checks apply to signed and unsigned apps. Windows Application Control may block an installed unsigned app.</p>
          <p>Optional <code>install.macos.testflight</code> declares bundle identifier, minimum system and architectures; <code>install.tvos</code> declares bundle identifier and minimum system. These describe support, not readiness. The install page uses only the matching entry in <code>release.apple</code> for an invitation and its version, separate from the direct-package release version.</p>
          <p>Separate Mac and Apple TV cards on the app page call <code>GET, POST /api/dev/apps/:id/testflight/:platform</code>. Setup does not require declaring a direct package. Add the platform to the app's existing App Store Connect record. Mac setup requires your browser session, provisions installer signing on the server, and offers native Mac or Mac Catalyst profile selection. Workflows fetch signing and upload using the platform-specific build addresses in <a href="/contract.md">the contract</a>.</p>
          <p>For an Apple TV public invitation, install TestFlight on iPhone or iPad and Apple TV using the same App Store account. Accept the link on the iPhone or iPad, then install from TestFlight on Apple TV using the remote. <a href="https://testflight.apple.com/" target="_blank" rel="noopener">Apple's instructions and current system requirements</a>. Board and player modes are app behaviour, not manifest properties.</p>
        </section>

        <section id="where">
          <h2>Where everything runs</h2>
          <figure class="ref-diagram">${optionalFigure("architecture.png", "How a typical app is hosted and installed through ourapps")}<div class="svg-fallback hidden">${architectureSvg()}</div></figure>
          <p>Three parties, three jobs. <b>Your repository</b> builds and holds the release files. <b>ourapps</b> turns a share link into an install: it reads the release, signs short-lived download links, signs iPhone builds and puts them on TestFlight, and links to the web version on your Cloudflare account. <b>Your backend</b>, if the app has one, is wherever you put it; the installed apps talk to it directly, so ourapps never sees app traffic and its limits never apply to your API.</p>
          <table class="table">
            <tr><th>Thing</th><th>Lives in</th><th>Reaches the phone by</th></tr>
            <tr><td>.ipa</td><td>uploaded by your workflow to Apple, through upload addresses ourapps reserves</td><td>TestFlight installs it; ourapps never stores it</td></tr>
            <tr><td>.apk</td><td>your GitHub release</td><td>streamed through ourapps on a signed link; not stored</td></tr>
            <tr><td>Web version</td><td>your Cloudflare account (or any host)</td><td><b>linked</b>, not proxied: the install page opens the address in <code>install.pwa</code></td></tr>
            <tr><td>web.zip bundle</td><td>your GitHub release</td><td><b>copied</b>: unpacked once per release into ourapps storage, served from <code>https://&lt;link&gt;.ourapps.app/</code></td></tr>
            <tr><td>my-app.json, CHANGELOG.md, icon, screenshots (general and per version)</td><td>your GitHub release</td><td>read by ourapps for the install page; images on signed links</td></tr>
            <tr><td>API, database, WebSockets, files your app uses</td><td>your host</td><td>called by the app directly</td></tr>
          </table>
        </section>

        <section id="ios">
          <h2>Native iPhone and iPad</h2>
          <p>Through Apple's TestFlight: friends install with Apple's free TestFlight app from a public invitation link. Nothing on the phone changes. ourapps does the Apple side.</p>
          <ol class="steps">
            <li><b>Signing setup, once.</b> Your browser makes an RSA key and a certificate request; with your App Store Connect key ourapps gets an Apple Distribution certificate (<code>POST /v1/certificates</code>) and stores the key encrypted.</li>
            <li><b>TestFlight setup, once per app.</b> You add the app in App Store Connect (Apple has no API for that); the TestFlight card on the app's page lists every field of Apple's New App form. ourapps finds it by bundle ID, makes an App Store profile, an external beta group with a public link (<code>/v1/betaGroups</code>), and fills in the beta review contact and description.</li>
            <li><b>Build.</b> Your workflow fetches certificate, key and the App Store profile from <code>/api/build/&lt;app&gt;/signing</code> with the app's build token and exports for <code>app-store-connect</code>.</li>
            <li><b>Upload.</b> The workflow asks ourapps to reserve an upload (<code>/v1/buildUploads</code>), sends the bytes straight to Apple's upload addresses, and tells ourapps the MD5. No Apple key in the repository.</li>
            <li><b>Distribute.</b> Every ten minutes ourapps checks Apple; once the build is processed it answers export compliance (no non-exempt encryption) where the build has no answer, adds it to the friends' group, sets What to Test from your release notes, submits it for beta review (the first build of each version) and, once approved, makes it available to the group.</li>
            <li><b>Open.</b> ourapps reads the public invitation page; the install page offers the invitation only while that page accepts testers.</li>
            <li><b>Keep it alive.</b> Builds last 90 days; two weeks before expiry ourapps sends <code>my-store-release</code> to the repository for a fresh build.</li>
          </ol>
          <ul class="bullets">
            <li>Limits: up to 10,000 testers per app through the public link; builds last 90 days; Apple's beta review checks the first build of each version.</li>
            <li>Updates arrive through TestFlight; data stays.</li>
            <li>ourapps holds the certificate's private key, encrypted per account, and gives it only to a workflow presenting the app's build token.</li>
            <li><b>iPad and universal apps:</b> build one .ipa with <code>TARGETED_DEVICE_FAMILY</code> <code>1,2</code>; TestFlight installs it on both.</li>
          </ul>
        </section>

        <section id="android">
          <h2>Native Android</h2>
          <ul class="bullets">
            <li>Publish a signed <b>universal .apk</b>. An .aab cannot be installed on a phone; convert it:
              <pre><code>bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal \\
  --ks=release.keystore --ks-pass=file:ks.pwd --ks-key-alias=app --key-pass=file:key.pwd
unzip app.apks universal.apk</code></pre></li>
            <li>Served as <code>application/vnd.android.package-archive</code> on a signed link valid for one hour.</li>
            <li>Keep one signing key forever and raise <code>versionCode</code> every release, or updates fail.</li>
            <li>The phone asks once to allow installs from the browser; Play Protect may warn about an unfamiliar developer. Google's developer verification rules for installs on certified Android phones, and its free limited distribution accounts for sharing with up to 20 devices, are at <a href="https://developer.android.com/developer-verification" target="_blank" rel="noopener">developer.android.com/developer-verification</a>.</li>
            <li>No device limit.</li>
          </ul>
        </section>

        <section id="web">
          <h2>Web apps</h2>
          <p><code>install.pwa</code> in my-app.json is the address the install page opens. Web apps run from the developer's own free Cloudflare account: the release workflow deploys the build as a Worker with files only, and Cloudflare serves plain files without a request limit or a charge. ourapps links to the address and never proxies it. A release asset named exactly <code>web.zip</code> is <b>bundle</b> mode: ourapps unpacks it and serves it at <code>https://&lt;link&gt;.ourapps.app/</code>, from ourapps' shared allowance.</p>
          <h3>On your own Cloudflare account</h3>
          <table class="table">
            <tr><th>Rule</th><th>Detail</th></tr>
            <tr><td>Setup</td><td>A free Cloudflare account, a token from the "Edit Cloudflare Workers" template, and the repository secrets <code>CLOUDFLARE_API_TOKEN</code> and <code>CLOUDFLARE_ACCOUNT_ID</code> (<a href="/dev/guide#cloudflare">guide</a>). ourapps never holds them.</td></tr>
            <tr><td>Deploy</td><td><code>npx wrangler deploy</code> with a <code>wrangler.jsonc</code> naming the build folder; the address is <code>https://&lt;name&gt;.&lt;subdomain&gt;.workers.dev/</code> and stays the same across releases. Steps in <a href="/contract.md">contract.md</a>.</td></tr>
            <tr><td>Size</td><td>20,000 files per deploy, 25 MB per file, 100 Workers per account (Cloudflare free plan)</td></tr>
            <tr><td>Compression</td><td>Cloudflare compresses <code>.html</code>, <code>.js</code>, <code>.css</code> and <code>.wasm</code> itself and does not honour <code>Content-Encoding</code> from <code>_headers</code>, so ship files uncompressed</td></tr>
            <tr><td>Your headers</td><td>A <code>_headers</code> file sets any header, for example <code>X-Robots-Tag: noindex</code> and the cross-origin isolation headers</td></tr>
            <tr><td>Home screen</td><td>The build carries a manifest, the Apple home screen tags and a copy of <code>https://ourapps.app/web/install-banner.js</code></td></tr>
            <tr><td>Privacy</td><td>The address is public: anyone who has it can open the app, and revoking a share link does not stop them. Storage and permissions belong to that address.</td></tr>
          </table>
          <h3>How a web.zip bundle is served</h3>
          <ol class="steps">
            <li>The first request after a new release fetches web.zip with your GitHub token and checks it against the limits below.</li>
            <li>The files are unpacked into about 2 MB packs in ourapps storage (a handful of writes per release). Packs are kept for 30 days and unpacked again when needed after that.</li>
            <li>Each request reads one file from the edge cache or its pack. The release is re-checked at most once a minute, so a new release goes live within a minute.</li>
            <li>The site is served at <code>https://&lt;link&gt;.ourapps.app/</code>, its own origin per share link, at the root.</li>
          </ol>
          <table class="table">
            <tr><th>Rule</th><th>Detail</th></tr>
            <tr><td>Size</td><td>web.zip up to 25 MB; up to 32 MB unpacked; any file up to 24 MB; up to 2,000 files</td></tr>
            <tr><td>Compression</td><td>Build the zip without compression (<code>zip -0 -r web.zip .</code>). At most 8 MB of compressed content is accepted, to keep unpacking within the server's CPU budget. Text is brotli-compressed on the way to the browser anyway.</td></tr>
            <tr><td>Layout</td><td><code>index.html</code> at the zip root or inside one top-level folder. Relative paths (<code>base: "./"</code>) or root paths both work, because each link is its own origin.</td></tr>
            <tr><td>Routing</td><td>Unknown paths without a file extension get <code>index.html</code>, so client-side routing works. Missing files with an extension get 404.</td></tr>
            <tr><td>Reserved</td><td><code>/__ourapps/</code>, <code>/api/</code>, <code>/dl/</code>, <code>/__cache/</code></td></tr>
            <tr><td>Caching</td><td>HTML <code>no-cache</code>; other files a day, with an ETag per release</td></tr>
            <tr><td>Pre-compressed files</td><td><code>.wasm.br</code>, <code>.js.gz</code>, <code>.data.br</code> and similar are sent with <code>Content-Encoding</code> and the inner type, the way Unity and Godot expect</td></tr>
            <tr><td>Your headers</td><td>A <code>_headers</code> file in the Cloudflare Pages format may set <code>Cross-Origin-Opener-Policy</code>, <code>Cross-Origin-Embedder-Policy</code>, <code>Cross-Origin-Resource-Policy</code>, <code>Permissions-Policy</code>, <code>Content-Security-Policy</code> and <code>Cache-Control</code>; other headers are ignored</td></tr>
            <tr><td>Added by ourapps</td><td>An add-to-home-screen banner script and, only when the page lacks them, a manifest, Apple home screen tags, an icon link and a theme colour</td></tr>
          </table>
          <h3>What a per-link origin means for web.zip apps</h3>
          <ul class="bullets">
            <li><b>Storage is per link.</b> localStorage, IndexedDB, service workers and permissions belong to <code>&lt;link&gt;.ourapps.app</code>. A friend who receives two links has two separate copies of local data, and revoking a link strands the data on that origin. Keep anything that must survive on your backend.</li>
            <li><b>Calling your API.</b> Allow the link origins in CORS, for example by matching <code>^https://[0-9a-f]{16,64}\\.ourapps\\.app$</code>. Authenticate with tokens in an <code>Authorization</code> header, not cookies: your API is on another site, and browsers block third-party cookies.</li>
            <li><b>Isolation.</b> The console's cookies are host-only and <code>__Host-</code> prefixed, so a bundle can neither read nor plant them, and the console refuses writes from other origins.</li>
          </ul>
        </section>

        <section id="engines">
          <h2>Engines and frameworks</h2>
          <table class="table">
            <tr><th>Tool</th><th>What to do</th></tr>
            <tr><td>Unity Web (Unity 6)</td><td>On your Cloudflare account: Compression Format "Disabled", or Brotli with Decompression Fallback. As web.zip served by ourapps: Brotli or Gzip work as built. Native multithreading needs <code>Cross-Origin-Opener-Policy: same-origin</code>, <code>Cross-Origin-Embedder-Policy: require-corp</code> and <code>Cross-Origin-Resource-Policy: cross-origin</code> in <code>_headers</code>. Unity lists iOS Safari 15 or later and Chrome 58 or later on Android as supported mobile browsers; test on real phones, where memory is the usual limit. The 32 MB unpacked limit applies to web.zip.</td></tr>
            <tr><td>Godot 4</td><td>The single-threaded web export (the default in Godot 4.3 and later) needs nothing. Thread or extension support needs the two cross-origin isolation headers in <code>_headers</code>.</td></tr>
            <tr><td>Flutter web</td><td>The default base href <code>/</code> works at the root of the app's address; the path URL strategy works thanks to the index fallback.</td></tr>
            <tr><td>Next.js</td><td><code>output: "export"</code> only. Not available as static files: server rendering, incremental regeneration, route handlers that read the request, middleware, rewrites, redirects and headers in next.config, Server Actions, the default image optimiser. Anything needing those: host it yourself and use a link.</td></tr>
            <tr><td>Vite, Angular, Astro, SvelteKit static</td><td>Static output, deployed to your Cloudflare account. SvelteKit needs the static adapter.</td></tr>
            <tr><td>Phaser, PlayCanvas, Three.js, Babylon.js</td><td>Static output; nothing special.</td></tr>
            <tr><td>Capacitor, Cordova</td><td>Native shells: publish the .ipa and .apk; optionally deploy the same web build to your Cloudflare account.</td></tr>
            <tr><td>React Native and Expo</td><td>Build the .ipa with the App Store profile for TestFlight and a universal .apk (local builds or your own CI); Expo's web output deploys to your Cloudflare account like any static build.</td></tr>
          </table>
        </section>

        <section id="backend">
          <h2>Your backend</h2>
          <ul class="bullets">
            <li>Host it anywhere with HTTPS. Native apps call it directly; web apps call it cross-origin, so allow the web app's address in CORS (for <code>web.zip</code> apps, the link origins).</li>
            <li>WebSockets and server-sent events work from all three flavours.</li>
            <li>ourapps does not proxy, meter or see your app's traffic; its request and storage limits are not yours.</li>
            <li>Typical stacks: Cloudflare Workers with D1 or Durable Objects, Supabase, Firebase, Fly.io, Render, a VPS, a machine at home behind a tunnel.</li>
          </ul>
        </section>

        <section id="limits">
          <h2>Limits</h2>
          <table class="table">
            <tr><th>Limit</th><th>Value</th><th>Set by</th></tr>
            <tr><td>iPhone and iPad people</td><td>10,000 per app through the TestFlight public link</td><td>Apple</td></tr>
            <tr><td>TestFlight build lifetime</td><td>90 days; ourapps asks for a fresh build two weeks before</td><td>Apple</td></tr>
            <tr><td>Android devices</td><td>none</td><td>n/a</td></tr>
            <tr><td>Signed download links</td><td>valid one hour; the page makes fresh ones on every load</td><td>ourapps</td></tr>
            <tr><td>Web app on your Cloudflare account</td><td>20,000 files per deploy, 25 MB per file, 100 Workers per account; plain files served without a request limit</td><td>Cloudflare</td></tr>
            <tr><td>web.zip bundle</td><td>25 MB zipped, 32 MB unpacked, 24 MB per file, 2,000 files, 8 MB compressed content</td><td>ourapps</td></tr>
            <tr><td>New web.zip release live</td><td>within a minute</td><td>ourapps</td></tr>
            <tr><td>Release assets</td><td>under 2 GB each</td><td>GitHub</td></tr>
            <tr><td>Whole service</td><td>100,000 requests a day and 1,000 storage writes a day on Cloudflare's free plan, shared by all developers; a web.zip release uses a handful of writes, and every visit to a web.zip app counts</td><td>Cloudflare</td></tr>
          </table>
        </section>

        <section id="topologies">
          <h2>Diagrams by app type</h2>
          <p class="muted">Each diagram opens full size in a new tab.</p>
          <div class="stack">
            ${TOPOLOGIES.map((t) => html`
              <div class="card topo" id="${t.id}">
                ${optionalFigure(t.file, t.title)}
                <h3>${t.title}</h3>
                <p class="small muted">${t.summary}</p>
                <dl class="kv small">${t.parts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
              </div>`)}
          </div>
        </section>
      </article>
    </div>
  `;
}

// Images show by default; a missing one is removed and, for the architecture figure, the drawn diagram takes its place.
export function wireFigures(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>("img[data-optional]").forEach((img) => {
    const link = img.closest<HTMLElement>(".figure-link");
    const fail = () => {
      img.closest("figure")?.querySelector(".svg-fallback")?.classList.remove("hidden");
      (link ?? img).remove();
    };
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) fail();
    else img.addEventListener("error", fail, { once: true });
  });
}

export async function referencePage(root: HTMLElement): Promise<void> {
  const me = await whoAmI(true);
  if (me && !termsPending(me)) {
    mountShell(root, me, "Technical reference", body(), { sub: "What kinds of app work, where every part runs, and the specifics behind each install path." });
  } else {
    setTheme("dev", "Technical reference · ourapps", true);
    mount(
      root,
      html`
        <div class="ref-public">
          <div class="topbar" style="display:block"><div class="row" style="max-width:1040px;margin:0 auto;padding-bottom:10px"><a class="brand" href="/" style="color:#fff">${icon("logo")} ourapps</a><span class="grow"></span><a href="/dev" style="color:var(--side-text)">Developer console</a></div></div>
          <main class="content fade-in">
            <div class="page-head"><div><h1>Technical reference</h1><p>What kinds of app work, where every part runs, and the specifics behind each install path.</p></div></div>
            ${body()}
            <footer class="console-footer">${COPYRIGHT} · <a href="/terms">Terms and data statement</a></footer>
          </main>
        </div>
      `,
    );
    wireImages(root);
    wireCopy(root);
  }
  wireFigures(root);
}

export { callout };
