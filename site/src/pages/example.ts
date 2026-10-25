// A worked example: Poker Night, an imaginary app for eight friends.
import { whoAmI, type LinkPage } from "../api.js";
import { html, mount } from "../html.js";
import { setTheme } from "../theme.js";
import { icon, wireCopy, wireImages } from "../ui.js";
import { renderInstall, storeFrame } from "./public.js";

export const POKER_NIGHT: LinkPage = {
  linkId: null,
  developer: { id: "example", slug: "dana", displayName: "Dana" },
  app: {
    id: "poker-night",
    name: "Poker Night",
    tagline: "Thursday table, house rules included",
    description:
      "Every Thursday the same eight of us sit around the same table. This is the app for that table and no other.\n\nIt runs the blinds, keeps the chip counts, remembers who owes who, and knows our house rules so nobody has to argue about them at midnight. If you are new, tap the question mark on any screen and it tells you what to do in one sentence.\n\nIt is not in any store and never will be. It is for us.",
    whatsNew: "Sam's rule is in: dealer's choice on the hour. The rematch button no longer resets the pizza tab. Bigger chip numbers for the far end of the table.",
    size: "18 MB",
    minOs: "iOS 17 or later, Android 10 or later",
    ageNote: "18+",
    privacySummary:
      "Everything stays on your phones. Chip counts and the pizza tab sync between the phones at the table over the local network and are gone when the table closes. No accounts, no server, no analytics. The photos are ours and go nowhere.",
    iconUrl: "",
    screenshots: [],
    updatedAt: "2026-10-09T19:30:00.000Z",
  },
  release: {
    version: "1.3.0",
    minPlayers: 2,
    maxPlayers: 9,
    install: {
      pwa: "https://example.invalid/poker-night/",
      android: { apk: "https://example.invalid/poker-night.apk" },
      ios: { bundleId: "com.example.pokernight", testflight: "https://example.invalid/testflight", devices: ["iphone", "ipad"] },
    },
    fallbackName: "Poker Night",
    fallbackIcon: "",
    fallbackDescription: "",
    fallbackScreenshots: [],
  },
  releaseError: null,
  screenshots: { all: [] },
  history: [
    { version: "1.3.0", tag: "v1.3.0", title: "", notes: "- Sam's rule is in: dealer's choice on the hour\n- Rematch no longer resets the pizza tab\n- Bigger chip numbers for the far end of the table\n- Help text for the new blinds structure, in Dana's words", date: "2026-10-09T19:30:00.000Z", sha: "a3f9c12e8b7d4f0a", releaseUrl: null, commitUrl: null },
    { version: "1.2.1", tag: "v1.2.1", title: "", notes: "- Pizza tab rounds to the nearest 50p like the table does\n- Seat map remembers who sat where last week", date: "2026-09-18T20:05:00.000Z", sha: "7b21d9ac4e5f0b13", releaseUrl: null, commitUrl: null },
    { version: "1.2.0", tag: "v1.2.0", title: "Seat map", notes: "- Seat map with everyone's name already in it\n- Dealer rotation\n- The glossary: the Dave, a cheeky limp, and friends", date: "2026-09-04T19:40:00.000Z", sha: "c0de4a1f9e2b7d35", releaseUrl: null, commitUrl: null },
    { version: "1.1.0", tag: "v1.1.0", title: "", notes: "- Chip counts and who owes who at the end\n- The three blinds structures, no editor", date: "2026-08-21T19:10:00.000Z", sha: "e5a7b3c1d9f04268", releaseUrl: null, commitUrl: null },
    { version: "1.0.0", tag: "v1.0.0", title: "First table night", notes: "Blinds timer and the four house rules. Built on a Tuesday, played on the Thursday.", date: "2026-08-07T18:55:00.000Z", sha: "91f2e8d7a6c5b340", releaseUrl: null, commitUrl: null },
  ],
};

export async function exampleApp(root: HTMLElement): Promise<void> {
  setTheme("store", "Poker Night, an example on ourapps", true);
  const me = await whoAmI();
  renderInstall(root, POKER_NIGHT, { me, pageUrl: `${location.origin}/example/poker-night`, example: true });
}

export async function examplePage(root: HTMLElement): Promise<void> {
  setTheme("store", "Why Poker Night: a worked example", true);
  const me = await whoAmI();
  mount(
    root,
    storeFrame(
      html`
        <article class="story" style="max-width:760px;margin:0 auto">
          <div style="padding:24px 0 8px">
            <span class="pill accent">Worked example</span>
            <h1 style="font-size:40px;margin-top:12px">Poker Night</h1>
            <p class="lead muted" style="font-size:19px">An app for eight people, built in an evening with a coding agent, installed from one link. Imaginary, but every detail is something ourapps does.</p>
            <div class="ctas row wrap"><a class="btn" href="/example/poker-night">See the page your friends get ${icon("arrow")}</a>${me ? html`<a class="btn secondary" href="/dev">Open your console</a>` : html`<a class="btn secondary" href="/api/auth/github">${icon("github")} Build yours</a>`}</div>
          </div>

          <h2>The idea</h2>
          <p>Every Thursday the same eight people sit around the same table. The poker apps in the stores are built for millions of strangers: four hundred settings, adverts, accounts, leaderboards, a shop for chips. Poker Night is built for one table. It does what that table does and nothing else.</p>
          <p class="quote">"I didn't want a poker app. I wanted our poker night, in an app."</p>

          <h2>Just enough options, and no more</h2>
          <p>Options are decisions you have not made yet. This table made them years ago, so the app has no settings page.</p>
          <ul class="rules">
            <li>${icon("check")}<span>A blinds timer with the three structures the table actually uses. Not a blinds editor.</span></li>
            <li>${icon("check")}<span>Chip counts and who owes who at the end, rounded the way the table rounds.</span></li>
            <li>${icon("check")}<span>Dealer rotation and a seat map with everyone's name already in it.</span></li>
            <li>${icon("check")}<span>The pizza tab, because that is where the real arguments were.</span></li>
          </ul>

          <h2>Your house rules, in the app</h2>
          <p>Written the way you say them, not the way a rulebook does, and shown at the moment they matter.</p>
          <ul class="rules">
            <li>${icon("info")}<span>Dealer's choice on the hour. The app announces it and lists the four games allowed.</span></li>
            <li>${icon("info")}<span>No string bets. Tap the pot and it explains what that means to whoever is new.</span></li>
            <li>${icon("info")}<span>The big loser buys the pizza. The app already knows who that is.</span></li>
            <li>${icon("info")}<span>Phones face down during a hand. Yes, the app says so, in Sam's words.</span></li>
          </ul>

          <h2>Tonnes of help for the friend who has never played</h2>
          <p>A store app explains poker to the world. This one explains it to your friends, in your table's words: what beats what, with pictures; a "what do I do now" button that describes the current decision in one sentence; a glossary of the table's slang ("the Dave", "a cheeky limp"). Nobody has to ask twice, and nobody has to pretend they knew.</p>

          <h2>Your own imagery</h2>
          <p>The table photo as the background. Your friend's face on the joker. The 2019 trophy on the winner screen. Things you would never put in a public store listing, and never get past review, are exactly what makes an app for eight people feel like theirs.</p>
          <p class="small muted">The audience is private and non-commercial, which lowers the stakes to those of a private joke, but it is still your responsibility: use photos you took or were given, and keep anything you borrowed inside the circle. The moment the app is for strangers, swap in art you own.</p>

          <h2>Test a real app with real people</h2>
          <p>The same mechanism carries serious projects. Before an app ever meets an App Store listing you can put it on up to 10,000 iPhones and iPads through TestFlight, which ourapps keeps fresh for you, and on as many Android phones as you like: real phones, real friends, real feedback. Family beta, club pilot, the first ten customers who happen to be mates.</p>

          <h2>How it got built: an agent and an evening</h2>
          <p>Describe the table to a coding agent (Claude Code, Codex, Cursor, opencode): who sits where, the three blind structures, the four rules, the slang. It writes the app. Paste the ourapps prompt from the console and it writes the release workflow too, including the TestFlight upload. You spend the evening on the house rules and the help text, which is the part only you can do.</p>

          <h2>How ourapps helps</h2>
          <ol class="steps">
            <li><b>Add the app.</b> Name, icon, a few lines, the GitHub repository. Blank fields get placeholders, so the page looks finished from day one.</li>
            <li><b>Create a share link.</b> One for the table, labelled "Thursday". It has a QR code for the fridge.</li>
            <li><b>Friends tap.</b> Android downloads and installs. iPhones get Apple's free TestFlight app, open the invitation on the page, and tap Install.</li>
            <li><b>Ship changes from the same link.</b> Push a tag, the release updates, the link serves the new version.</li>
          </ol>

          <h2>Limits, honestly</h2>
          <div class="compare">
            <div class="card">
              <h3>${icon("phone", "icon-20")} iPhone</h3>
              <ul>
                <li><b>Through TestFlight:</b> friends need Apple's free TestFlight app; up to 10,000 people per app.</li>
                <li>Apple's beta review checks the first build of each version, usually within a day. It is lighter than App Store review, but Apple's rules still apply.</li>
                <li>Each build lasts 90 days. ourapps asks your repository for a fresh build before then, so friends keep the app.</li>
                <li>Needs the Apple Developer Program, 99 US dollars a year.</li>
              </ul>
            </div>
            <div class="card">
              <h3>${icon("android", "icon-20")} Android and web</h3>
              <ul>
                <li><b>No device limit.</b> A share link can reach as many Android phones as you like.</li>
                <li>Android asks once per phone to allow installs from the browser, and Play Protect may warn about an unknown developer. The install page walks through both.</li>
                <li>Google's developer verification rules for installs on certified Android phones, and its free limited distribution accounts for sharing with up to 20 devices, are at <a href="https://developer.android.com/developer-verification" target="_blank" rel="noopener">developer.android.com/developer-verification</a>.</li>
                <li>Web apps have no limits and no prompts beyond "Add to Home Screen".</li>
              </ul>
            </div>
          </div>
          <p class="small muted">Share links themselves are unlimited and never expire unless you say so. Everything runs on free tiers; the only cost is Apple's developer membership, which you need for iPhone apps anyway.</p>

          <h2>How updates happen</h2>
          <p><b>iPhone updates itself; Android waits for a tap.</b> TestFlight installs new iPhone builds; on Android no store runs in the background, so an installed copy stays as it is until the friend taps Update. What that takes:</p>
          <div class="compare">
            <div class="card"><h3>For your friends</h3><ul><li><b>iPhone:</b> TestFlight installs the new version, by itself when automatic updates are on. Settings and saved data stay.</li><li><b>Android:</b> tap Update, tap Install when the phone asks. Data stays as long as you signed with the same key.</li><li><b>Web app:</b> nothing; it refreshes itself.</li></ul></div>
            <div class="card"><h3>For you</h3><ul><li>Push a tag. The workflow publishes a release; the share link serves it at once.</li><li>ourapps uploads the iPhone build to TestFlight and sends it to your friends once Apple has processed it and, for a new version, approved it in beta review.</li><li>Bump the version numbers (Android versionCode, iOS CFBundleVersion) or phones will refuse the update.</li><li>Do not change the Android signing key, ever.</li></ul></div>
          </div>

          <h2>Setting up auto-update</h2>
          <p>Phones will not check for you, but your app can. ourapps gives every share link a small endpoint the app polls on launch:</p>
          <pre><code>GET https://ourapps.app/api/public/links/&lt;linkId&gt;/latest
{
  "name": "Poker Night",
  "version": "1.3.0",
  "testflightUrl": "https://testflight.apple.com/join/...",
  "apple": { "ios": { "version": "1.2.0", "testflightUrl": "https://testflight.apple.com/join/..." }, "macos": null, "tvos": null },
  "android": { "apkUrl": "https://ourapps.app/dl/..." },
  "pwa": null,
  "linksExpireAt": "2026-10-16T11:00:00.000Z"
}</code></pre>
          <ol class="steps">
            <li>Create a share link labelled "In-app updates" and never revoke it. Bake its id into the app.</li>
            <li>On launch, fetch <code>/latest</code>. Android compares <code>version</code>; iPhone and iPad compare the approved <code>apple.ios.version</code>. A null Apple entry means no ready invitation.</li>
            <li>If newer, show one button. Android opens <code>android.apkUrl</code>. TestFlight updates Apple apps itself; an optional button opens the matching <code>apple.ios.testflightUrl</code>. Mac and Apple TV use only their own Apple entries.</li>
            <li>Fetch right before opening: the install links are good for an hour.</li>
          </ol>
          <p>The <a href="/dev/guide#updates">guide</a> has the Swift and Kotlin snippets, and the agent prompt asks your coding agent to add the check for you.</p>

          <h2>And the path to the real store later</h2>
          <p>When Poker Night is ready for strangers, nothing is thrown away. The same code and the same release workflow already sign for the App Store and upload to TestFlight; the private photos make way for art you own, a privacy policy gets written, and the build goes to App Store review. Your friends keep installing from their link the whole time, and afterwards too, if you like.</p>

          <div class="card pad-l mt center">
            <h2 style="margin-top:0">Your Poker Night is something else</h2>
            <p class="muted">A walking group, a family recipe box, a scoreboard for the five-a-side, a timer for the allotment. The pattern is the same: an evening with an agent, a link to the people who will use it.</p>
            <div class="ctas row wrap" style="justify-content:center">${me ? html`<a class="btn lg" href="/dev">Open your console</a>` : html`<a class="btn lg" href="/api/auth/github">${icon("github")} Sign in with GitHub</a>`}<a class="btn lg secondary" href="/example/poker-night">See the install page</a></div>
          </div>
        </article>
      `,
      { me },
    ),
  );
  wireImages(root);
  wireCopy(root);
}
