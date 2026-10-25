// The developer guide: everything from first sign-in to the first friend installing.
import { CATEGORIES, CHECKED, PRINCIPLES, servicePrompt, type Service } from "../freeTiers.js";
import { escapeHtml, html, raw, type Raw } from "../html.js";
import { callout, icon, wireCopy } from "../ui.js";
import { diagram, wireFigures } from "./reference.js";
import { mountShell, requireMe } from "./shell.js";

interface Section { id: string; title: string; body: Raw; sub?: { id: string; title: string }[] }

const path = (text: string) => html`<span class="path">${text}</span>`;
const kbd = (text: string) => html`<span class="kbd">${text}</span>`;

function sections(origin: string, slug: string): Section[] {
  return [
    {
      id: "tldr",
      title: "TL;DR: what only you can do",
      body: html`
        ${callout("info", html`<p><b>Most of this guide is for your information, not your to-do list.</b> The prompts on <a href="/dev/agents">Agents and API</a> and the documents at <a href="/agents.md">agents.md</a> and <a href="/contract.md">contract.md</a> tell a coding agent everything below. Give an agent an API key and those prompts and it registers the app, sets up the repository, publishes releases, creates share links and checks TestFlight. The steps that remain are the ones that need your identity, your money or your judgement.</p>`)}
        <h3>You, once per account</h3>
        <ol class="steps">
          <li><b>Sign in with GitHub</b> at <a href="/dev">/dev</a>. An agent cannot do this; it is your identity.</li>
          <li><b>Create a GitHub fine-grained token</b> (Contents read and write; Actions read for status, or read and write for Mac/Apple TV requests) on your app repositories and paste it under <a href="/dev/settings#credentials">Settings</a>. Tokens are created on GitHub while signed in as you. <a href="/dev/guide#github-token">Steps</a>.</li>
          <li><b>Apple TestFlight apps: pay for the Apple Developer Program</b> (99 US dollars a year), then create an <b>App Store Connect API key</b> with the Admin role and paste issuer id, key id and the .p8 contents under Settings, plus your team id. Saving it sets up Apple Distribution signing. <a href="/dev/guide#apple-key">Steps</a>.</li>
          <li><b>Web apps only: create a free Cloudflare account</b> and a token that lets your workflows deploy to it. Your web apps then run from your account, free and without a request limit. <a href="/dev/guide#cloudflare">Steps</a>.</li>
          <li><b>Create one API key</b> on <a href="/dev/agents">Agents and API</a> and store it where your agent runs. Keys are made from a browser session only; agents cannot mint their own.</li>
        </ol>
        <h3>You, once per app</h3>
        <ol class="steps">
          <li><b>iPhone apps: nothing in the Apple portal, one step in App Store Connect.</b> The app needs its iPhone bundle ID, which the agent sets when it registers the app. ourapps creates the App ID, the profile and the certificate it signs with, and the repository holds no Apple secrets. Add the app once in App Store Connect: the TestFlight card on the app's page lists every field to fill in and finishes the rest by itself. <a href="/dev/guide#testflight">How</a>.</li>
          <li><b>Android apps: put the signing keystore into the repository</b>, with its passwords. The agent can run <code>gh secret set</code> for you if you hand it the values, but the values come from you.</li>
          <li><b>Web apps: add the two Cloudflare secrets</b> (<code>CLOUDFLARE_API_TOKEN</code>, <code>CLOUDFLARE_ACCOUNT_ID</code>) to the repository, the same way.</li>
        </ol>
        <h3>You, as things happen</h3>
        <ol class="steps">
          <li><b>Wait for Apple's beta review</b> of the first build of each new iPhone version. The app's TestFlight card says what it is waiting for.</li>
          <li><b>Send the share link</b> to the person. The agent can create it and give you the URL and QR code; the message to your friend is yours.</li>
          <li><b>Before the signing certificate's yearly expiry</b> (the date is under <a href="/dev/settings#signing">Settings</a>), press <b>Replace certificate</b> there. ourapps makes the profile of every app on TestFlight again with it.</li>
          <li><b>Approve the release notes</b> for each version in <code>CHANGELOG.md</code>. An agent drafts them from the commits; they are shown to your friends as the revision history, so the final words are yours. <a href="/dev/guide#release-notes">How</a>.</li>
        </ol>
        <h3>Everything else: hand it to an agent</h3>
        <ul class="bullets">
          <li>Registering the app with its listing text, icon and screenshots (<code>POST /api/dev/apps</code>).</li>
          <li>Writing the release workflow, my-app.json, the TestFlight upload and the in-app update check in the repository (prompt 1).</li>
          <li>Storing <code>STORE_BUILD_TOKEN</code> and <code>STORE_APP_ID</code> as repository secrets.</li>
          <li>Cutting releases, checking <code>/release</code> status and fixing what it reports.</li>
          <li>Creating, labelling, revoking share links; checking TestFlight (prompt 2).</li>
        </ul>
        <p class="small muted">Rule of thumb: if it needs a password, a payment, a signing key, or a decision about a person, it is yours. If it is typing, reading a file, or calling this API, it is the agent's.</p>
        <p class="small muted">Wondering whether your kind of app fits (Unity, Flutter, server-rendered sites, games with a server)? The <a href="/reference">technical reference</a> lists the supported types, where every part runs and the exact limits.</p>
      `,
    },
    {
      id: "overview",
      title: "What ourapps does",
      body: html`
        <p>ourapps shares apps you build with people you know, on phones, tablets, computers, Apple TV and the web. You add an app in this console, create a share link, and send it. Your friend opens the link and gets the install choices for their device.</p>
        <div class="grid-2">
          <div class="card flat"><h3>${icon("android", "icon-20")} Android</h3><p>The page offers a direct download of your signed APK and walks the friend through the one-time "allow from this source" prompt. Nothing else is needed.</p></div>
          <div class="card flat"><h3>${icon("phone", "icon-20")} iPhone and iPad</h3><p>Friends install through Apple's free TestFlight app from an invitation on the install page, with nothing to change on their phone. ourapps signs each build, uploads it to TestFlight and sends it to your friends; Apple reviews the first build of each version, and ourapps asks for a fresh build before the 90-day expiry.</p></div>
          <div class="card flat"><h3>${icon("globe", "icon-20")} Web apps</h3><p>Your repository deploys the built site to your own free Cloudflare account, which serves plain files without a request limit. The install page opens it, and the app offers a one-tap add to the home screen. Details in the <a href="/reference#web">reference</a>.</p></div>
          <div class="card flat"><h3>Mac and Windows</h3><p>Publish .dmg or .exe packages with their architecture, minimum system, signing and Mac notarization status. The page offers named package choices alongside the web version. A Mac browser does not identify its chip reliably.</p></div>
          <div class="card flat"><h3>Mac and Apple TV TestFlight</h3><p>The app page has separate setup buttons for each platform. Save the app's Apple bundle identifier, add the platform to its existing App Store Connect record, then check with Apple. Mac setup uses your browser session and provisions the installer signing key on the server. A matching ready build and open invitation are required; declaring a platform in my-app.json does not open its invitation.</p></div>
          <div class="card flat"><h3>${icon("lock", "icon-20")} Private by design</h3><p>No search, no listing, no index. Install pages live at random addresses, the app files are served through links that expire after an hour, and a share link can be revoked at any time.</p></div>
        </div>
        <p>The whole thing runs on free tiers. The only paid item is Apple's developer membership, which you need for iPhone apps anyway.</p>
        ${diagram("architecture.png", "How a typical app is hosted and installed through ourapps")}
        <p class="small muted">ourapps distributes; your repository builds; your backend, if you have one, serves the app directly. Every app type with its own diagram and the exact limits: <a href="/reference">technical reference</a>.</p>
      `,
    },
    {
      id: "sign-in",
      title: "1. Sign in",
      body: html`
        <ol class="steps">
          <li>Open <a href="${origin}/dev">${origin}/dev</a> and tap <b>Sign in with GitHub</b>. Any GitHub account works, including a free one.</li>
          <li>GitHub asks you to allow ourapps to read your public profile (scope <code>read:user</code>). That is all sign-in reads. Repository access comes later, from a token you create yourself.</li>
          <li>You land on the console. Your public page address is set from your GitHub login, for example <a href="/${slug}">${origin}/${slug}</a>. Change it and your display name under <a href="/dev/settings">Settings</a>; the display name is what friends see on every install page.</li>
        </ol>
        ${callout("info", html`<p>Sign-in lasts 30 days on a browser. Sign out from the sidebar. The console is a normal website; nothing to install.</p>`)}
      `,
    },
    {
      id: "credentials",
      title: "2. Keys the console needs (you)",
      sub: [
        { id: "github-token", title: "GitHub token" },
        { id: "apple-key", title: "App Store Connect key" },
        { id: "apple-setup", title: "iPhone signing" },
        { id: "cloudflare", title: "Cloudflare (web apps)" },
        { id: "android-setup", title: "Android signing" },
      ],
      body: html`
        <p>Two credentials live in <a href="/dev/settings#credentials">Settings</a>, encrypted per account. Android-only apps need just the first.</p>

        <h3 id="github-token">GitHub token (all apps)</h3>
        <p>The console reads your release files straight from GitHub Releases and, for iPhone apps, asks your repository for a fresh build before a TestFlight build expires. Both need a token that can read and write the app repository's contents.</p>
        <ol class="steps">
          <li>On GitHub, open your avatar, ${kbd("Settings")}, ${kbd("Developer settings")}, ${kbd("Personal access tokens")}, ${kbd("Fine-grained tokens")}, ${kbd("Generate new token")}.</li>
          <li>Name it <b>ourapps</b>. Expiration: pick the longest you are comfortable with (one year) and put a reminder in your calendar.</li>
          <li><b>Repository access:</b> "Only select repositories", then pick the app repositories.</li>
          <li><b>Permissions, Repository permissions:</b> set <b>Contents</b> to <b>Read and write</b> for releases and iPhone/iPad build requests. Set <b>Actions</b> to <b>Read</b> for status and timing, or <b>Read and write</b> to request Mac/Apple TV workflows. Metadata is added automatically.</li>
          <li>Generate, copy the token (it starts with <code>github_pat_</code>), paste it into <a href="/dev/settings#credentials">Settings</a> and save. The console confirms "saved" with the date.</li>
        </ol>
        ${callout("info", html`<p>When you add a new app repository later, edit the token on GitHub and add the repository to it. The console does not need a new token.</p>`)}

        <h3 id="apple-key">App Store Connect API key (iPhone apps)</h3>
        <p>This is how the console creates the certificate your iPhone builds are signed with, its profiles, and puts builds on TestFlight. You need a paid Apple Developer Program membership (99 US dollars a year).</p>
        <ol class="steps">
          <li>Open <a href="https://appstoreconnect.apple.com/access/integrations/api" target="_blank" rel="noopener">App Store Connect, Users and Access, Integrations, App Store Connect API</a>. If you have never used it, tap <b>Request Access</b> first.</li>
          <li>Under <b>Team Keys</b>, tap the plus. Name: <b>ourapps</b>. Access: <b>Admin</b>. Certificates and provisioning profiles are only editable with Admin, which is why the lower roles do not work.</li>
          <li>Tap <b>Download API Key</b>. You get a <code>.p8</code> file exactly once; keep it somewhere safe.</li>
          <li>Copy the <b>Issuer ID</b> (top of the page) and the key's <b>Key ID</b>.</li>
          <li>In <a href="/dev/settings#credentials">Settings</a> paste Issuer ID, Key ID and the full contents of the .p8 file (including the BEGIN and END lines). Save.</li>
          <li>Your <b>Team ID</b> is on <a href="https://developer.apple.com/account" target="_blank" rel="noopener">developer.apple.com/account</a> under Membership details. Paste it too.</li>
        </ol>

        <h3 id="apple-setup">iPhone signing</h3>
        <p>Saving the App Store Connect key sets up iPhone signing by itself; if it did not finish, press <b>Set up iPhone signing</b> under <a href="/dev/settings#signing">Settings</a>. Nothing is done by hand in the Apple developer portal:</p>
        <ol class="steps">
          <li>Your browser makes a private key and a certificate request. ourapps asks Apple for an <b>Apple Distribution</b> certificate with it and keeps the key encrypted like your credentials.</li>
          <li>When an app goes on TestFlight, ourapps finds or creates the App ID for its <b>iPhone bundle ID</b> and makes its <b>App Store</b> profile.</li>
          <li>The release workflow fetches certificate, key and profile with the app's build token from <code>/api/build/&lt;app&gt;/signing</code>, so the repository holds no Apple secrets. The <a href="/contract.md">contract</a> shows the exact commands.</li>
        </ol>
        ${callout("info", html`<p>TestFlight needs the app added once in App Store Connect; the app's page lists the exact values. See <a href="#testflight">step 6</a>.</p>`)}
        <p class="small muted">The certificate lasts a year: press <b>Replace certificate</b> under Settings before then. ourapps makes the App Store profile of every app on TestFlight again with the new one, and the next build uses it. The old certificate stays valid until it expires or you revoke it in the developer portal.</p>

        <h3 id="cloudflare">Cloudflare account (web apps)</h3>
        <p>Web apps run from your own free Cloudflare account. Cloudflare serves plain files without a request limit or a charge, your repository's workflow deploys them, and ourapps only links to the address. ourapps never sees the token.</p>
        <ol class="steps">
          <li>Create a free account at <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">dash.cloudflare.com</a>. Use a separate one if your existing account runs Workers you care about: Cloudflare cannot limit the token to one Worker, so it can replace any Worker on the account.</li>
          <li>Open <b>Workers &amp; Pages</b> and choose your <b>workers.dev subdomain</b>, for example your name. Web apps appear at addresses like <code>https://skull-web.yourname.workers.dev</code>.</li>
          <li>Open <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">My Profile, API Tokens</a>, tap <b>Create Token</b> and use the template <b>Edit Cloudflare Workers</b>. Account Resources: your account. Zone Resources: all zones from that account. Continue, Create, then copy the token; it is shown once.</li>
          <li>Copy the <b>Account ID</b> from Workers &amp; Pages (Account details).</li>
          <li>In each web app's repository add two secrets: ${kbd("Settings")}, ${kbd("Secrets and variables")}, ${kbd("Actions")}, <code>CLOUDFLARE_API_TOKEN</code> and <code>CLOUDFLARE_ACCOUNT_ID</code>. Or, inside the repository, <code>gh secret set CLOUDFLARE_API_TOKEN</code> and <code>gh secret set CLOUDFLARE_ACCOUNT_ID</code>. A personal GitHub account has no account-wide secrets, so each repository needs its own pair; an organisation can share one pair across its repositories.</li>
        </ol>
        ${callout("info", html`<p>The agent prompt writes the rest: a settings file for a Worker with files only, a deploy step in the release workflow, and the address in my-app.json. The app's page in this console shows whether the address answers.</p>`)}
        <ul class="bullets small">
          <li><b>The address is public.</b> Anyone who has it can open the app, and revoking a share link does not stop them. Keep anything private behind the app's own sign-in.</li>
          <li><b>Unity and other pre-compressed builds:</b> Cloudflare compresses files itself, so build without pre-compression, or turn on Unity's Decompression Fallback.</li>
          <li><b>Apps that publish <code>web.zip</code></b> are served by ourapps at their link addresses and use ourapps' shared allowance. When the latest release has no <code>web.zip</code> and <code>install.pwa</code> names another address, the link addresses redirect there, so icons on friends' home screens keep opening the app.</li>
        </ul>

        <h3 id="android-setup">Android signing</h3>
        <p>Android needs no account and no console credential, only a signing key your workflow uses. Create one once:</p>
        <pre><code>keytool -genkeypair -v -keystore release.keystore -alias app -keyalg RSA -keysize 2048 -validity 10000
base64 -i release.keystore | pbcopy   # paste as the secret ANDROID_KEYSTORE_BASE64</code></pre>
        <p>Keep the keystore and passwords; an APK signed with a different key cannot update an installed app. Google's developer verification rules for installs on certified Android phones, and its free limited distribution accounts for sharing with up to 20 devices, are at <a href="https://developer.android.com/developer-verification" target="_blank" rel="noopener">developer.android.com/developer-verification</a>.</p>
      `,
    },
    {
      id: "add-app",
      title: "3. Add your app (agent can do this)",
      body: html`
        ${callout("info", html`<p><b>For your information.</b> With an API key, prompt 2 on <a href="/dev/agents">Agents and API</a> lets an agent do this whole section: it creates the app, stores the build token in the repository, and reports the app id. Read on only if you prefer the form.</p>`)}
        <p>Go to <a href="/dev/apps/new">Apps, Add an app</a>. Every field except the name and repository is optional, and blank fields get sensible placeholders, so you can add the app now and polish the listing later. What each field does:</p>
        <table class="table">
          <tr><th>Field</th><th>Shows up as</th><th>Tip</th></tr>
          <tr><td>Name, tagline, icon</td><td>The header of the install page</td><td>Icon square, 512 pixels or more, https URL. Blank icon falls back to my-app.json, then to a generated tile.</td></tr>
          <tr><td>Description</td><td>About section, with "more" when long</td><td>Say what it is and why you made it. Two or three short paragraphs beat one long one.</td></tr>
          <tr><td>What's new</td><td>The What's new section</td><td>Shown only when the latest release has no notes of its own; release notes from CHANGELOG.md take precedence.</td></tr>
          <tr><td>Privacy summary</td><td>App privacy card</td><td>Plain words: what is stored, where it goes, who can see it.</td></tr>
          <tr><td>Size, compatibility, age</td><td>Facts strip and Information</td><td>Compatibility is free text, for example "iOS 17 or later".</td></tr>
          <tr><td>Screenshots</td><td>Preview carousel, per version</td><td>A general list plus optional lists for iPhone, iPad, Android, Web, Mac, Windows and Apple TV, one URL per line. A version without its own list shows the general one or the closest other version. Blank lists fall back to my-app.json, then generated previews. Computers offer the matching native version, web and Apple TV instructions when declared.</td></tr>
          <tr><td>Repository</td><td>Not shown</td><td><code>owner/name</code>. The console reads the latest release here.</td></tr>
          <tr><td>iPhone bundle ID</td><td>Not shown</td><td>The bundle identifier in your Xcode project. ourapps creates the App ID and the App Store profile for it.</td></tr>
          <tr><td>Show on my public page</td><td>Your /${slug} page</td><td>Details only, never install links. Off by default.</td></tr>
        </table>
        <p>On <b>Create</b>, the console shows the app's <b>build token</b> once, together with the app id. Put both into the repository as Actions secrets straight away:</p>
        <ol class="steps">
          <li>On GitHub: repository, ${kbd("Settings")}, ${kbd("Secrets and variables")}, ${kbd("Actions")}, ${kbd("Repository secrets")}, ${kbd("New repository secret")}. Create <code>STORE_BUILD_TOKEN</code> and <code>STORE_APP_ID</code>.</li>
          <li>Or in a terminal inside the repository: <code>gh secret set STORE_BUILD_TOKEN</code> then <code>gh secret set STORE_APP_ID</code>, pasting the values when asked.</li>
        </ol>
        <p>Lost the token? Open the app and tap <b>New build token</b>; the old one stops working at once.</p>
        <p>Use <b>Preview install page</b> at any time to see exactly what a friend will see, with your current text and whatever the latest release provides.</p>
      `,
    },
    {
      id: "release",
      title: "4. Make the repository publish releases (agent does this)",
      sub: [{ id: "release-notes", title: "Release notes" }, { id: "web-apps", title: "Web apps: home screen" }],
      body: html`
        ${callout("info", html`<p><b>For your information.</b> Prompt 1 on <a href="/dev/agents">Agents and API</a>, pasted into a coding agent inside the repository, writes everything in this section. What remains for you is the Android signing keystore.</p>`)}
        <p>The console never looks at your source code. It reads one file, <code>my-app.json</code>, from the latest GitHub Release of the repository, and follows the URLs inside it. Your repository therefore needs a release workflow that:</p>
        <ol class="steps">
          <li>Builds the signed APK and, for iPhone apps, an <code>.ipa</code> signed for the App Store, which it uploads to TestFlight through ourapps.</li>
          <li>Creates a GitHub Release as a draft, uploads <code>icon.png</code>, screenshots, the <code>.apk</code> and <code>my-app.json</code> last, then publishes it. A release that goes public before its files are in makes install pages fail until <code>my-app.json</code> arrives.</li>
          <li>Writes every URL inside my-app.json as a release-asset API URL (<code>https://api.github.com/repos/owner/name/releases/assets/123</code>). Private repositories work this way and nothing is guessable; the console turns them into short-lived links for the phone.</li>
          <li>For iPhone apps: fetches the certificate, its key and the App Store profile from the console with the build token, uploads the build through ourapps, and also runs on the <code>my-store-release</code> event ourapps sends for the first build, when you ask for a build on the app's TestFlight card, and two weeks before a TestFlight build expires. The <a href="/contract.md">contract</a> spells out every step.</li>
        </ol>
        ${callout("info", html`<p><b>Let an agent do it.</b> On <a href="/dev/agents">Agents and API</a> there is a prompt, pre-filled for your app, that you paste into a coding agent working inside the repository. It writes the workflow and the my-app.json generation to the contract.</p>`)}
        <h3>What my-app.json looks like</h3>
        <pre><code>{
  "schema": 1,
  "id": "skull",
  "name": "Skull",
  "version": "0.1.1",
  "description": "Skull-style bluffing card game for 3 to 6 friends.",
  "icon": "https://api.github.com/repos/you/skull/releases/assets/645774606",
  "minPlayers": 3,
  "maxPlayers": 6,
  "screenshots": ["https://api.github.com/repos/you/skull/releases/assets/645774610"],
  "install": {
    "pwa": null,
    "android": { "apk": "https://api.github.com/repos/you/skull/releases/assets/645774607" },
    "ios": { "bundleId": "com.you.skull", "testflight": "https://testflight.apple.com/join/AbCd1234" }
  }
}</code></pre>
        <p>Use <code>null</code> for platforms you do not ship. <code>minPlayers</code> and <code>maxPlayers</code> are 1 for anything that is not a game.</p>
        <h3 id="release-notes">Release notes your friends will read</h3>
        <p>The install page shows a <b>Revision history</b>: one entry per release, with the version, the date, the commit it was built from, and notes. Automated bodies such as "Automated build 53 of version 0.7.2" are what friends see when nobody writes anything, so write the notes. The mechanism:</p>
        <ol class="steps">
          <li>Keep a <code>CHANGELOG.md</code> at the repository root in <a href="https://keepachangelog.com" target="_blank" rel="noopener">Keep a Changelog</a> form: one <code>## [version] - date</code> section per version, newest first, bullets written for the people who use the app. An <code>[Unreleased]</code> section at the top is fine; the store ignores it.</li>
          <li>The release workflow uploads <code>CHANGELOG.md</code> as a release asset (next to my-app.json) and uses the section for the version being released as the release body. Make the workflow fail when the section is missing, so a release without notes cannot happen by accident.</li>
          <li>The store reads the <code>CHANGELOG.md</code> from the latest release and matches sections to versions. Precedence per version: changelog section, then release body, then the commit message.</li>
        </ol>
        <pre><code># Changelog

## [Unreleased]

## [0.7.2] - 2026-10-17
### Fixed
- Dealing order when someone joins mid-round
### Changed
- Bigger chip numbers for the far end of the table

## [0.7.1] - 2026-10-16
### Added
- Rematch button</code></pre>
        <p>Headings like <code>### Added</code> become "Added:" labels on the page; bullets stay bullets; GitHub's generated "by @user in ..." and "Full Changelog" lines are dropped; links to GitHub appear only when the repository is public. The Latest release card in the console says whether the release shipped a changelog. An agent can draft the entry from the commits; the words to your friends are yours to approve.</p>

        <h3 id="web-apps">Web apps: home screen and permissions</h3>
        <p>The web version runs from your own Cloudflare account (<a href="#cloudflare">setup</a>). Its build carries a web app manifest, the Apple home screen tags and a copy of ourapps' small banner script (<code>https://ourapps.app/web/install-banner.js</code>), which offers "Add to home screen": Chrome's native install prompt on Android, the exact Share steps on iPhone Safari, and an "open in Safari" hint inside in-app browsers. Once added, the app launches from the icon in standalone mode and the banner never shows again. Apps published as <code>web.zip</code> get the same pieces added by ourapps.</p>
        <p>No web page can place a shortcut on its own; the user's single tap is required by both platforms. The banner makes that tap obvious.</p>
        <h3>Camera and microphone without asking every time</h3>
        <p>Permissions are stored per origin, and the home screen app shares the origin, so a grant survives. What to know:</p>
        <ul class="bullets">
          <li><b>Android (Chrome):</b> a grant in the installed app is permanent until the user changes it in site settings. The first prompt appears once.</li>
          <li><b>iPhone Safari in a tab:</b> Safari forgets <code>getUserMedia</code> grants when the tab closes, which is the "asks every time" problem. <b>From the home screen it remembers</b> for as long as the app stays installed. That is the main reason to push the shortcut.</li>
          <li><b>Ask at the right moment:</b> call <code>getUserMedia</code> from a tap handler (a "Join table" or "Start" button), never on page load; browsers block or silently deny unprompted requests, and users deny what they did not expect.</li>
          <li><b>Reuse, do not re-ask:</b> keep the stream for the session; stopping all tracks and asking again triggers a fresh prompt on some versions. Check <code>navigator.permissions.query({ name: "camera" })</code> where supported and skip the explanation screen when it is already <code>granted</code>.</li>
          <li><b>Guard against the in-app browser:</b> Instagram's and Facebook's web views often have no camera access at all. The banner tells users to open in Safari; your app can show the same when <code>getUserMedia</code> is missing.</li>
        </ul>
        <pre><code>// Ask from a tap, reuse the stream, remember the outcome.
let stream;
startButton.onclick = async () => {
  if (!navigator.mediaDevices?.getUserMedia) return showOpenInSafariHint();
  stream ??= await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
  video.srcObject = stream;
};</code></pre>
        <p class="small muted">Push notifications on iPhone also work only from the home screen app (iOS 16.4 or later), another reason to get the shortcut in place.</p>

        <h3>Check it</h3>
        <p>Open the app in the console. The <b>Latest release</b> card shows the tag, the version, the platforms and the assets it found, or the exact reason it could not read the release. Tap <b>Check again</b> after you push a fix. Common reasons:</p>
        <table class="table">
          <tr><th>Message</th><th>Fix</th></tr>
          <tr><td>no release visible on owner/name</td><td>The repository does not exist, has no published release, or is private and needs a GitHub token. Save the token in Settings with the repository selected on it.</td></tr>
          <tr><td>no published release visible on owner/name</td><td>Publish a release that is not a draft or pre-release (the latest one is used), or add the repository to the GitHub token.</td></tr>
          <tr><td>has no asset named my-app.json</td><td>The workflow must upload the file with exactly that name.</td></tr>
          <tr><td>my-app.json for <i>app</i> is invalid: ...</td><td>The message names the field. URLs must be https; schema must be 1.</td></tr>
        </table>
      `,
    },
    {
      id: "share",
      title: "5. Share with friends (agent creates the link, you send it)",
      body: html`
        <p>Open the app, tap <b>Share links</b>, give the link a label and create it, or ask your agent: "create a share link for Poker Night labelled Thursday table". The link is <code>${origin}/l/</code> followed by a random id; it does not list anywhere and search engines are told to stay away. Sending it to the person is the part that stays with you.</p>
        <h3>Good habits</h3>
        <ul class="bullets">
          <li><b>One link per person or group.</b> Labels like "Mum and Dad" or "Tuesday board game crowd" let you revoke one without touching the others. Rename a link any time with <b>Rename</b> next to its label; its address does not change.</li>
          <li><b>Expiry</b> is optional. Friends who installed keep the app when a link expires or is revoked, and only new installs stop; a <code>web.zip</code> app served at the link's own address stops opening.</li>
          <li><b>QR code.</b> Each active link shows one and you can download it as a file for a printed card.</li>
        </ul>
        <h3>Sending it</h3>
        <ul class="bullets">
          <li><b>Messages, WhatsApp:</b> tap Share next to the link. On iPhone these open the page in Safari's own view, where installing works.</li>
          <li><b>Email:</b> paste the link. Gmail's built-in browser cannot install, so the page tells the friend to open it in Safari or Chrome.</li>
          <li><b>Instagram, Facebook, TikTok:</b> their in-app browsers cannot install. The page detects them and shows an "Open in Safari" instruction with the extra tap.</li>
        </ul>
        <h3>What the friend sees</h3>
        <div class="grid-2">
          <div class="card flat"><h3>On Android</h3><ol class="steps small"><li>Taps <b>Get</b>; the APK downloads.</li><li>Taps the download; Android asks to allow installs from Chrome, once.</li><li>Taps Install. Play Protect may say it has not seen this developer before; "Install anyway" continues.</li></ol></div>
          <div class="card flat"><h3>On iPhone</h3><ol class="steps small"><li>Taps <b>Get</b>, then <b>Get TestFlight</b> if they do not have Apple's TestFlight app.</li><li>Taps <b>Open the invitation</b>; TestFlight opens.</li><li>Taps <b>Accept</b>, then <b>Install</b>. The icon appears; TestFlight keeps it up to date.</li></ol></div>
        </div>
        <p>On a computer the page shows the QR code and asks them to open it on their phone.</p>
      `,
    },
    {
      id: "testflight",
      title: "6. iPhone and iPad through TestFlight (ourapps does the work)",
      body: html`
        <p>Friends install iPhone and iPad apps through Apple's free TestFlight app, from an invitation link ourapps shows on the install page. They change no settings, and there is nothing for you to approve.</p>
        <h3>Once per app</h3>
        <p>The <b>TestFlight</b> card on the app's page in the console lists these steps, ticks off the ones already done and says exactly what to do next.</p>
        <ol class="steps">
          <li>The app has its <b>iPhone bundle ID</b>, iPhone signing is set up, and the beta review contact is saved (once for all apps; the card asks for it).</li>
          <li>Add the app in <a href="https://appstoreconnect.apple.com/apps" target="_blank" rel="noopener">App Store Connect</a>. Apple lets nobody else do this. The card lists every field of Apple's <b>New App</b> form with what to type, and ourapps registers the bundle ID with Apple first so it is in the form's list.</li>
          <li>While the app's page is open, the card notices the app within 15 seconds and finishes by itself: the App Store profile, a beta group with a public invitation link, and what Apple's beta review needs. It then asks the repository for the first build.</li>
          <li>ourapps answers Apple's export compliance question for every build: no non-exempt encryption (<code>ITSAppUsesNonExemptEncryption</code> false). Share only apps for which that is true.</li>
        </ol>
        <p>The invitation is a public link: anyone who has it can join, with no invitation per person. Apple's page for it refuses testers until a build has passed beta review, so the install page offers it only once ourapps has found that page open; until then friends on iPhone see "coming soon", with the web version when there is one.</p>
        <h3>Every release</h3>
        <p>The <b>GitHub build</b> panel shows Requested, Pending, Running or Complete, with Failed and Cancelled outcomes. Running progress is a time-based estimate from up to five successful runs of the same workflow, using their job completion times. It stays below 100% until GitHub reports success. The run link opens the actual GitHub log. Mac/Apple TV require a matching platform workflow title; a generic release run does not count. A successful run with no matching upload shows <b>Finished without upload</b>, with its export/upload steps to check.</p>
        <table class="table">
          <tr><th>State on the app page</th><th>Meaning</th></tr>
          <tr><td>uploading</td><td>The workflow is sending the build to Apple through ourapps</td></tr>
          <tr><td>with Apple</td><td>The upload is complete and Apple has the file</td></tr>
          <tr><td>Apple is processing it</td><td>Apple checks the build; ourapps answers Apple's export compliance question for it</td></tr>
          <tr><td>in Apple's beta review</td><td>In the friends' group and with Apple's beta review; the first build of each version is reviewed</td></tr>
          <tr><td>friends can install it</td><td>Approved, and the invitation accepts testers</td></tr>
        </table>
        ${callout("info", html`<p><b>Builds last 90 days.</b> ourapps checks every ten minutes and asks the repository for a fresh build (<code>my-store-release</code>) two weeks before the newest one expires, so friends keep the app without you doing anything.</p>`)}
        <p class="small muted">Apple's beta review is lighter than App Store review, but Apple's rules apply. Up to 10,000 people per app can join through the link.</p>
      `,
    },
    {
      id: "updates",
      title: "7. Updates and auto-update (agent does the work)",
      sub: [{ id: "auto-update", title: "Auto-update" }],
      body: html`
        <p><b>Android does not update on its own; iPhone and web apps do.</b> TestFlight installs new iPhone builds itself and a web app loads the new version when it opens; Android has no store in the background, so an installed copy stays as it is until someone taps Update. Here is what each side does.</p>
        <table class="table">
          <tr><th>Who</th><th>What happens</th></tr>
          <tr><td>You</td><td>Bump the version, push a tag. The workflow publishes a release and uploads the iPhone build to TestFlight; the share link serves the new version at once.</td></tr>
          <tr><td>Friend on iPhone</td><td>Nothing, with TestFlight's automatic updates on; otherwise one tap on Update in TestFlight. Settings and data stay.</td></tr>
          <tr><td>Friend on Android</td><td>Taps Update, then Install when the phone asks. Data stays as long as the signing key is the same.</td></tr>
          <tr><td>Friend on a web app</td><td>Nothing. The next time the app opens it loads the new version, unless the app's own service worker keeps an old copy.</td></tr>
        </table>
        <ul class="bullets">
          <li><b>Version numbers must go up:</b> Android <code>versionCode</code> and iOS <code>CFBundleVersion</code>, or the phone refuses the update as "older".</li>
          <li><b>Never change the Android signing key.</b> A different key means uninstall and reinstall, with data loss.</li>
          <li><b>TestFlight builds expire</b> 90 days after upload. ourapps asks the repository for a fresh build two weeks before, so this needs nothing from you; the app's page shows each build's state.</li>
          <li><b>Removing someone:</b> revoke their link. Installed copies keep working, apart from <code>web.zip</code> apps served at that link's address; TestFlight testers can be removed in App Store Connect. There is no remote uninstall, same as any app.</li>
        </ul>

        <h3 id="auto-update">Auto-update: let the app check for itself</h3>
        <p>Phones will not check for you, but your app can. Every active share link has a small endpoint for exactly this:</p>
        <pre><code>GET https://ourapps.app/api/public/links/&lt;linkId&gt;/latest

{
  "name": "Skull",
  "version": "0.1.2",
  "testflightUrl": "https://testflight.apple.com/join/AbCd1234",
  "apple": {
    "ios": { "version": "0.1.1", "testflightUrl": "https://testflight.apple.com/join/AbCd1234" },
    "macos": null,
    "tvos": null
  },
  "android": { "apkUrl": "https://ourapps.app/dl/..." },
  "pwa": null,
  "linksExpireAt": "2026-10-16T11:00:00.000Z"
}</code></pre>
        <ol class="steps">
          <li>Create a share link labelled <b>In-app updates</b> and never revoke it (revoking it stops update checks for everyone who has the app). Put its id in the app.</li>
          <li>On launch, fetch <code>/latest</code>. For direct packages compare <code>version</code>. For TestFlight compare only the running platform's <code>apple.ios.version</code>, <code>apple.macos.version</code> or <code>apple.tvos.version</code>; a null entry means no ready invitation. A failed fetch means no update.</li>
          <li>If newer, show one button. Android opens <code>android.apkUrl</code>. Desktop downloads open the share page for package selection. TestFlight updates apps itself; an optional button opens only the matching Apple entry's <code>testflightUrl</code>. Direct Mac package versions and Mac TestFlight versions are separate.</li>
          <li>Fetch right before opening the link, because the signed links inside are good for an hour.</li>
        </ol>
        <p class="small muted">The agent prompt on <a href="/dev/agents">Agents and API</a> asks your coding agent to add this check.</p>
        <h3>Swift (iOS)</h3>
        <pre><code>struct Invitation: Decodable { let version: String; let testflightUrl: String }
struct AppleVersions: Decodable { let ios: Invitation? }
struct Latest: Decodable { let apple: AppleVersions }

func checkForUpdate() async {
    guard let url = URL(string: "https://ourapps.app/api/public/links/LINK_ID/latest"),
          let (data, _) = try? await URLSession.shared.data(from: url),
          let latest = try? JSONDecoder().decode(Latest.self, from: data),
          let approved = latest.apple.ios,
          let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
          approved.version.compare(current, options: .numeric) == .orderedDescending,
          let install = URL(string: approved.testflightUrl) else { return }
    // Show your own "Update to \(approved.version)" button, then:
    await UIApplication.shared.open(install)
}</code></pre>
        <h3>Kotlin (Android)</h3>
        <pre><code>data class Latest(val version: String, val android: AndroidPart?) { data class AndroidPart(val apkUrl: String) }

suspend fun checkForUpdate(context: Context) {
    val latest = runCatching { fetchJson&lt;Latest&gt;("https://ourapps.app/api/public/links/LINK_ID/latest") }.getOrNull() ?: return
    val current = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: return
    if (!isNewer(latest.version, current) || latest.android == null) return
    // Show your own "Update to ${"$"}{latest.version}" button, then:
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(latest.android.apkUrl)))
}</code></pre>
        <p class="small muted">Android installs from the browser need the one-time "allow from this source" permission the friend already granted at first install. For a smoother in-app install, download the APK yourself and hand it to the package installer with a content URI; the one-tap confirmation remains.</p>
      `,
    },
    {
      id: "public-page",
      title: "8. Your public page",
      body: html`
        <p><a href="/${slug}">${origin}/${slug}</a> shows your display name and the apps you switched on with "Show on my public page". It is details only: no install buttons, no links, and search engines are told not to index it. Use it when someone asks "what have you built?"; hand out share links when they want one.</p>
      `,
    },
    {
      id: "agents",
      title: "9. Agents and the API (how to hand it over)",
      body: html`
        <p>Everything in this console is also an API, so a coding agent can do the repetitive parts.</p>
        <ol class="steps">
          <li>On <a href="/dev/agents">Agents and API</a>, create an API key. It is shown once; store it as the environment variable <code>OURAPPS_API_KEY</code> where the agent runs. A key acts as you, except for what needs you in a browser: creating and revoking keys, credentials, iPhone signing, accepting the terms, signing out everywhere and deleting the account. Revoke it there at any time.</li>
          <li>Copy prompt 1 into an agent working inside the app repository. It sets up the release workflow, my-app.json and the TestFlight upload.</li>
          <li>Copy prompt 2 into an agent that should drive the console: register apps, check releases, set up TestFlight, make share links.</li>
        </ol>
        <p>Reference for humans and agents: <a href="/agents.md">${origin}/agents.md</a> (endpoints, request and response shapes, workflows) and <a href="/contract.md">${origin}/contract.md</a> (what a repository must publish).</p>
        <h3>How keys and credentials are protected</h3>
        <ul class="bullets">
          <li>Each credential field is encrypted on its own (AES-256-GCM) under a key derived for your account from a secret that exists only in the server's secret store, never in the database.</li>
          <li>API keys, build tokens and sign-in sessions are stored as keyed hashes. A copy of the database cannot be used to sign in or to forge a key.</li>
          <li>API keys have a scope (read only, or manage) and an optional expiry. They can never create keys or change credentials; those need you in a browser.</li>
          <li>Settings, Security shows your recent security events and has "Sign out everywhere".</li>
        </ul>
      `,
    },
    {
      id: "free-tiers",
      title: "Free services: why small apps cost nothing to run",
      sub: CATEGORIES.map((c) => ({ id: c.id, title: c.title })),
      body: freeTiersBody(),
    },
    {
      id: "security",
      title: "Security: how your secrets, your account and your friends are protected",
      sub: [
        { id: "security-credentials", title: "Credentials" },
        { id: "security-access", title: "Who can act on your account" },
        { id: "security-friends", title: "Your friends" },
        { id: "security-artefacts", title: "App files and links" },
        { id: "security-you", title: "What is yours to do" },
      ],
      body: html`
        <p>Security is the reason this service exists in the shape it does: a private installer holds the keys to your Apple developer account and your repositories. This section says exactly what is held, how it is protected, and where the limits are. The same statements, in contractual form, are in the <a href="/terms">terms and data statement</a> you accepted at sign-up.</p>

        <h3 id="security-credentials">Your credentials</h3>
        <table class="table">
          <tr><th>What</th><th>How it is stored</th><th>When it is decrypted</th></tr>
          <tr><td>App Store Connect key (issuer id, key id, .p8), Apple team id</td><td>AES-256-GCM, one ciphertext per field, under a key derived for your account alone (HKDF from the master secret), with your account id and the field name bound in as authenticated data so a ciphertext cannot be moved between accounts or fields</td><td>Only inside one request or scheduled check: setting up signing or TestFlight, a workflow's upload, and the ten-minute check that looks after TestFlight builds</td></tr>
          <tr><td>GitHub token</td><td>Same scheme</td><td>Only when reading a release or workflow status, or asking the repository for a fresh build</td></tr>
          <tr><td>Apple Distribution and Mac Installer Distribution private keys</td><td>Same scheme; the app signing key is made in your browser and the installer key during Mac setup on the server</td><td>Only when an app's release workflow presents that app's build token; the installer key is returned only for Mac builds</td></tr>
          <tr><td>API keys, build tokens, sign-in sessions</td><td>Keyed hashes (HMAC-SHA256 with a pepper derived from the master secret); the key itself is shown to you once and never stored</td><td>Never; a presented key is hashed and compared</td></tr>
          <tr><td>Download links for app files</td><td>Signed with their own secret; expire after one hour</td><td>n/a</td></tr>
        </table>
        <ul class="bullets">
          <li>The master secret exists only in the Cloudflare Worker secret store. It is not in the database, not in the code, not in the repository. A copy of the database on its own yields no credential, no usable key and no session, and nothing can be forged from it.</li>
          <li>The master secret can be rotated without downtime; records are rewrapped as they are used.</li>
          <li>Credentials are validated before storage (the Apple key must be a real EC P-256 key, the GitHub token must have GitHub's shape) and are never returned by any endpoint: the console only ever sees "saved" and a date.</li>
          <li>Level N Ltd staff do not read your credentials. The service decrypts a field at the moment it is needed and discards it with the request.</li>
        </ul>

        <h3 id="security-access">Who can act on your account</h3>
        <ul class="bullets">
          <li><b>You, in a browser.</b> Sign-in is GitHub OAuth reading your public profile only. The session cookie is HttpOnly, Secure, SameSite, lasts 30 days, and is stored as a keyed hash. State-changing requests are refused unless they come from this site. "Sign out everywhere" under Settings ends every session.</li>
          <li><b>Your agents, with an API key.</b> Each key has a scope (read only, or manage), an expiry you choose, and can be revoked alone or all at once. A key can never create or revoke keys, change credentials, delete your account or sign out sessions; those need you in a browser. Keys are per developer: no key can see another developer's apps or links.</li>
          <li><b>Your app's repository, with a build token.</b> Per app, used to fetch the signing certificate, its key and the App Store profile, and to upload builds to TestFlight through ourapps. Whoever holds it can sign builds as you and send them to your TestFlight, so keep it in repository secrets only; rotate it on the app's page.</li>
          <li><b>Nobody else.</b> There is no shared admin interface; every row is tied to one developer and every query is filtered by it.</li>
          <li>Every security event (sign-in, sign-out, credential saves and removals, iPhone signing setup, key creation and revocation, build token rotation, app deletion, terms acceptance) is recorded with the country of the request and shown to you under Settings, Security.</li>
        </ul>

        <h3 id="security-friends">Your friends</h3>
        <ul class="bullets">
          <li>iPhone and iPad installs go between the friend and Apple through TestFlight; ourapps records nothing about them.</li>
          <li>Android and web installs record nothing about the friend. Install pages set no cookies and load no analytics or third-party scripts.</li>
        </ul>

        <h3 id="security-artefacts">App files and share links</h3>
        <ul class="bullets">
          <li>Your release files stay in your GitHub repository, public or private. Phones never receive a GitHub address; they receive a signed one-hour link to this service, which fetches the file with your token and streams it on.</li>
          <li>Share links are random ids, never listed, never indexed, revocable at any time, and may carry an expiry. A revoked link shows "no longer active"; the friend keeps what they installed.</li>
          <li>Web apps run on their own address (your Cloudflare account, or a per-link address for <code>web.zip</code> apps), so they cannot read your console session.</li>
          <li>Every response carries HSTS, a strict Content Security Policy, no-sniff, frame-deny and a cross-origin opener policy.</li>
        </ul>

        <h3 id="security-you">What is yours to do</h3>
        <ul class="bullets">
          <li>Protect your GitHub account and your Apple account with two-factor sign-in; this service can only be as safe as the sign-in in front of it.</li>
          <li>Limit the GitHub token to the app repositories, with an expiry: Contents read and write, plus Actions read for status or read and write for Mac/Apple TV requests.</li>
          <li>Create one API key per agent or machine, with an expiry, and revoke it when the job is done.</li>
          <li>Keep build tokens and the Cloudflare token in repository secrets only. A build token lets its holder fetch your iPhone signing key; a Cloudflare token can replace any Worker on its account.</li>
          <li>Check Settings, Security now and then. Anything you do not recognise: sign out everywhere, revoke keys, and replace the GitHub token and Apple key at their sources.</li>
        </ul>
        <p class="small muted">Full technical statement, including the rotation procedure and what is not covered: <a href="https://github.com/george-mcintyre/ourapps/blob/main/SECURITY.md" target="_blank" rel="noopener">SECURITY.md</a> in the source repository. Found a security problem? <a href="https://github.com/george-mcintyre/ourapps/security/advisories/new" target="_blank" rel="noopener">Report it privately</a>.</p>
      `,
    },
    {
      id: "troubleshooting",
      title: "10. Troubleshooting",
      body: html`
        <table class="table">
          <tr><th>Symptom</th><th>Cause and fix</th></tr>
          <tr><td>No icon or version in the console; the app's Latest release card says the console cannot read a release</td><td>The card lists the cause. Usually no GitHub token is saved, or the repository is not selected on it: Settings, GitHub token.</td></tr>
          <tr><td>Latest release says "no asset named my-app.json"</td><td>The workflow uploaded it under another name or to a pre-release. Names are exact; the latest non-draft, non-pre-release is used.</td></tr>
          <tr><td>The TestFlight card stays at "Add the app in App Store Connect"</td><td>The app is not in App Store Connect yet, or was added with another bundle ID. Follow the card's steps and choose the bundle ID it names; the card moves on by itself within 15 seconds, or press Check now.</td></tr>
          <tr><td>A fresh-build request fails with a GitHub 404</td><td>The token cannot write to that repository. Edit the token on GitHub: add the repository, Contents read and write.</td></tr>
          <tr><td>Release fails at the web deploy with "register a workers.dev subdomain"</td><td>The Cloudflare account has no workers.dev subdomain yet. Workers &amp; Pages, choose one, then run the release again. Renaming it later moves every web app's address.</td></tr>
          <tr><td>Web app opens but cannot reach its server</td><td>The server does not allow the web app's address. Add the exact address, for example <code>https://skull-web.yourname.workers.dev</code>, to the server's CORS list.</td></tr>
          <tr><td>Install page says the app has no published build yet, for a minute after a release</td><td>The release went public before <code>my-app.json</code> was uploaded. Create releases as drafts and publish them after every file is in.</td></tr>
          <tr><td>The TestFlight invitation says "This beta isn't accepting any new testers right now"</td><td>No build has passed Apple's beta review yet, or the public link is off. The app's TestFlight card says which, and what it waits for. Until it opens, the install page tells friends on iPhone and iPad that the app is coming soon.</td></tr>
          <tr><td>Nothing happens when tapping Open the invitation on iPhone</td><td>The page is inside another app's browser (Gmail, Instagram). Open in Safari. WhatsApp and Messages are fine.</td></tr>
          <tr><td>Android says "App not installed"</td><td>An older build signed with a different key is installed. Uninstall it first, or keep the signing key stable.</td></tr>
          <tr><td>Play Protect blocks the install</td><td>Tap More details, Install anyway. If there is no such button, the device policy forbids unknown sources (work phones).</td></tr>
        </table>
      `,
    },
    {
      id: "limits",
      title: "11. Limits and costs",
      body: html`
        <ul class="bullets">
          <li><b>Apple Developer Program:</b> 99 US dollars a year. <b>TestFlight:</b> up to 10,000 people per app through the public link; each build lasts 90 days and ourapps asks for a fresh one before then; Apple reviews the first build of each version.</li>
          <li><b>Android and web:</b> no device limit and no account. Google's developer verification rules for installs on certified Android phones, and its free limited distribution accounts for sharing with up to 20 devices, are at <a href="https://developer.android.com/developer-verification" target="_blank" rel="noopener">developer.android.com/developer-verification</a>.</li>
          <li><b>Share links:</b> unlimited, and they only expire when you set a date.</li>
          <li><b>GitHub:</b> free. Releases are free storage; private repositories get 2,000 Actions minutes a month, and macOS minutes count ten times. A lean iOS job takes 8 to 15 minutes, so budget roughly 15 iPhone builds a month on the free tier, or run iOS builds on your own Mac.</li>
          <li><b>ourapps itself:</b> free. It runs on Cloudflare's free tier: 100,000 requests a day, which is thousands of install pages.</li>
          <li><b>File size:</b> GitHub Release assets up to 2 GB each. Android phones download the APK through ourapps, so keep builds reasonable for mobile data.</li>
        </ul>
      `,
    },
  ];
}

// Escapes text and turns `code` spans into <code>.
function inline(text: string): Raw {
  return raw(escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>"));
}

// Host plus the last path segment, so several links to one site stay distinct.
function sourceLabel(u: string): string {
  const url = new URL(u);
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last ? `${url.host.replace(/^www\./, "")}/${last}` : url.host.replace(/^www\./, "");
}

function serviceCard(s: Service): Raw {
  const badge = s.verdict === "pick" ? html`<span class="pill ok">recommended</span>` : s.verdict === "avoid" ? html`<span class="pill bad">avoid</span>` : "";
  return html`
    <details class="service" id="svc-${s.id}">
      <summary><b>${s.name}</b> ${badge} <span class="faint small">${s.plan}</span><span class="service-fits small muted">${s.fits}</span></summary>
      <div class="service-body">
        <div class="grid-2">
          <div><h4>Free allowance</h4><ul class="bullets small">${s.free.map((f) => html`<li>${inline(f)}</li>`)}</ul></div>
          <div><h4>Watch out</h4><ul class="bullets small">${s.catches.map((f) => html`<li>${inline(f)}</li>`)}</ul></div>
        </div>
        <h4>Agent setup</h4>
        <ol class="bullets small">${s.setup.map((f) => html`<li>${inline(f)}</li>`)}</ol>
        ${s.env?.length ? html`<p class="small">Secrets: ${raw(s.env.map((e) => `<code>${escapeHtml(e)}</code>`).join(", "))}</p>` : ""}
        <p class="tiny faint">Sources: ${raw(s.sources.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(sourceLabel(u))}</a>`).join(" · "))}</p>
        ${s.verdict !== "avoid" ? html`<button type="button" class="btn sm secondary" data-copy="${servicePrompt(s)}">${icon("copy")} Copy agent prompt</button>` : ""}
      </div>
    </details>`;
}

function freeTiersBody(): Raw {
  return html`
    <p>AI coding agents make it practical to build an app for eight people. That has a second effect that is easy to miss: <b>at eight people, the expensive parts of an app become free.</b> Video calls, realtime multiplayer servers, databases and AI all have free plans sized for hobby use, and a group of friends sits comfortably inside them. A public app with the same features would pay for every one.</p>
    <div class="grid-2">
      <div class="card flat"><h3>${icon("devices", "icon-20")} Video calls</h3><p class="small">LiveKit's free plan gives 5,000 participant minutes a month: about twenty one-hour calls with four people. Skull and McInPoker put every player's face at the table on it.</p></div>
      <div class="card flat"><h3>${icon("apps", "icon-20")} Multiplayer</h3><p class="small">Skull's own cost model (<code>skull/server</code>, <code>npm run costs</code>) shows a four-player table on hibernating WebSockets fits about 80 hours of play a day in Cloudflare's free plan, against about 23 hours when the same game polls.</p></div>
      <div class="card flat"><h3>${icon("lock", "icon-20")} Data</h3><p class="small">Free databases hold hundreds of megabytes; a game history or a shared list for a family is kilobytes.</p></div>
      <div class="card flat"><h3>${icon("bot", "icon-20")} AI</h3><p class="small">On-device models (Apple, Android, Chrome) cost nothing per use, and free tiers cover a few hundred requests a day. Your personal AI subscription builds the app but must not power it for others; see the AI section.</p></div>
    </div>
    <h3>Rules that apply to every service</h3>
    <ul class="bullets">${PRINCIPLES.map((p) => html`<li>${inline(p)}</li>`)}</ul>
    ${callout("info", html`<p><b>For agents:</b> everything below, with full setup steps, is at <a href="/free-tiers.md">ourapps.app/free-tiers.md</a>. Each service has a <b>Copy agent prompt</b> button that tells your agent to read its section, check the current limits and wire it in. Numbers were checked on the providers' pages on ${CHECKED}; free tiers change, so the prompt asks the agent to re-check.</p>`)}
    ${CATEGORIES.map((c) => html`
      <h3 id="${c.id}" class="ft-category">${c.title}</h3>
      <p>${inline(c.why)}</p>
      ${c.practices?.length ? html`<details class="practices"><summary><b>Best practices for ${c.title.toLowerCase()}</b></summary><ul class="bullets small">${c.practices.map((p) => html`<li>${inline(p)}</li>`)}</ul></details>` : ""}
      <div class="services">${c.services.map(serviceCard)}</div>
    `)}
  `;
}

export async function guide(root: HTMLElement): Promise<void> {
  const me = await requireMe(root);
  if (!me) return;
  const list = sections(location.origin, me.developer.slug);
  mountShell(
    root,
    me,
    "Guide",
    html`
      <div class="guide">
        <nav class="toc" id="toc">
          ${list.map((s) => html`<a href="/dev/guide#${s.id}" data-toc="${s.id}">${s.title}</a>${(s.sub ?? []).map((x) => html`<a class="sub" href="/dev/guide#${x.id}">${x.title}</a>`)}`)}
          <hr /><a href="/agents.md">agents.md</a><a href="/contract.md">contract.md</a>
        </nav>
        <article>
          ${list.map((s) => html`<section id="${s.id}"><h2>${s.title}</h2>${s.body}</section>`)}
          <p class="small faint">Something missing or wrong? The source is public: <a href="https://github.com/george-mcintyre/ourapps/issues" target="_blank" rel="noopener">open an issue on github.com/george-mcintyre/ourapps</a>. Security problems: <a href="https://github.com/george-mcintyre/ourapps/security/advisories/new" target="_blank" rel="noopener">report them privately</a>, never in a public issue.</p>
        </article>
      </div>
    `,
    { sub: "From first sign-in to the first friend installing, in order." },
  );
  const tocLinks = [...root.querySelectorAll<HTMLAnchorElement>("[data-toc]")];
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        tocLinks.forEach((a) => a.classList.toggle("active", a.dataset.toc === e.target.id));
      }
    },
    { rootMargin: "-10% 0px -80% 0px" },
  );
  root.querySelectorAll("article section").forEach((s) => observer.observe(s));
  wireFigures(root);
  wireCopy(root);
}
