// The public site. The app itself lives at /app; the demo kitchen at /demo; the free trial at /trial.
// Same colours, type and pieces as the app, so moving from here into it feels like one product.
// Every picture on this page is the app's own screens drawn in HTML, not a screenshot: they stay
// sharp, follow light and dark, and translate with the rest of the page.
import { ArrowRight, Bell, BookOpen, CalendarDays, CalendarOff, Check, FileText, Globe, Languages, ListChecks, MapPin, Store, Users } from "lucide-react";
import { HeatLogo } from "./heat-logo";
import { AuthForward } from "./auth-forward";
import { LanguageSwitch } from "./language";
import { Reveal } from "./landing-motion";
import { NightTimeline, ProductTour, RoleSwitch, type Role } from "./landing-sections";

const FACTS = [
  ["AI tutor", "that knows your menu"],
  ["FOH + BOH", "in one schedule"],
  ["English · Español", "every screen"],
  ["14 days free", "no card needed"],
];

// What a restaurant puts away when it runs on HEAT.
const REPLACES = ["WhatsApp group", "Menu binder", "Side work whiteboard", "Schedule app", "Swaps by text", "Paper shift report"];

const ROLE_VIEWS: Role[] = [
  {key: "owner", label: "Owner or GM", line: "Know how last night went before you get to the restaurant.", who: "Owners and GMs", items: ["Labor and sales for the week, every location side by side", "Urgent reports reach your phone the moment they're sent", "Ask the assistant what the reports keep saying"]},
  {key: "floor", label: "Floor manager", line: "Pre-shift, side work and sections are out before 5.", who: "Floor managers", items: ["Build the front of house and publish it to every phone", "Send tonight's side work and sections in a few taps", "Approve swaps with the hours in front of you"]},
  {key: "chef", label: "Chef", line: "The line's schedule and the 86 list stay in your hands.", who: "Head chefs and sous chefs", items: ["Build the kitchen schedule on your own", "86 what's out and the floor sees it right away", "A kitchen chat, separate from the floor"]},
  {key: "team", label: "Server or bartender", line: "Study the new menu on the bus, not in the binder.", who: "Servers, bartenders and cooks", items: ["Your shifts, side work and section on your phone", "A tutor that helps you study and sell", "Release or swap a shift without a single text"]},
];

const MORE = [
  {icon: CalendarOff, title: "Time off and on-call", text: "Time-off requests, weekly availability and on-call shifts, approved where the schedule is built."},
  {icon: Languages, title: "Words to know", text: "How to say it and what it means, for every term a guest might ask about."},
  {icon: Store, title: "Standards and story", text: "Your service standards and the story of the house, written once and read by everyone."},
  {icon: FileText, title: "Printable sheets", text: "Dish cards, allergy sheets, the pre-shift and the week's schedule, as clean PDFs."},
  {icon: Users, title: "Access per person", text: "Decide who can change the menu, the pre-shift, the team, or each side of the schedule."},
  {icon: Bell, title: "Phone notifications", text: "Schedules, offered shifts, approvals, time off and urgent reports, as they happen."},
  {icon: Globe, title: "English and Spanish", text: "Every screen in either language, one tap away. What you write stays as you wrote it."},
  {icon: MapPin, title: "Every location", text: "Each location keeps its own menu, team and schedule; open a new one and bring over only the dishes it shares."},
];

const FAQ = [
  ["Does my team need to download an app?", "No. HEAT opens in the phone's browser from the invite link. They can add it to the home screen and turn on notifications, like any app."],
  ["Can the kitchen and the floor build their own schedules?", "Yes. Give the floor manager the front-of-house schedule and the head chef or sous chef the kitchen. Each builds, publishes and approves only their side; the GM sees both."],
  ["Does it work in Spanish?", "Every screen works in English and Spanish, and each person picks their own. Dish names and notes stay exactly as you wrote them."],
  ["Is the allergy check a guarantee?", "No, and it never pretends to be. It shows what to avoid and what to confirm, based on what your restaurant recorded. The kitchen always has the last word."],
  ["We have more than one location.", "Each location gets its own workspace, team and schedule under your brand. The owner moves between them and compares them side by side."],
  ["Is the AI tutor safe with allergens?", "It only repeats what your cards say, and when a card doesn't say, it tells them to ask the kitchen. It teaches the craft too, from describing a dish to classic cocktails and selling, but your menu and your standards always win."],
  ["What can the manager assistant see?", "Only what that manager's access lets them see in the app: the schedule, the team's study and the shift reports. It never changes anything until the manager confirms."],
  ["Can I see it before adding my own menu?", "Open the demo kitchen: the real app with a sample menu, team and week of shifts, no account needed. Then start a 14-day trial with your own, no card."],
];

export default function Landing() {
  return <div className="site">
    <AuthForward />
    <Reveal />
    <header className="site-nav">
      <div className="site-wrap site-nav-inner">
        <a href="/" className="site-logo" aria-label="HEAT home"><HeatLogo /></a>
        <nav className="site-links" aria-label="Sections">
          <a href="#product">Product</a>
          <a href="#tutor">AI tutor</a>
          <a href="#schedule">Schedule</a>
          <a href="#roles">For your team</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="site-lang"><LanguageSwitch compact /></div>
        <div className="site-actions">
          <a href="/app" className="btn secondary">Sign in</a>
          <a href="/trial" className="btn">Start free trial</a>
        </div>
      </div>
    </header>

    <main>
      {/* ── Hero ── */}
      <section className="site-hero brand-aside lp-hero">
        <div className="lp-glow" aria-hidden="true" />
        <div className="site-wrap site-hero-grid">
          <div className="enter">
            <p className="lp-kicker"><span className="lp-dot" aria-hidden="true" />Built inside a working restaurant</p>
            <h1 className="site-title lp-title">Great service<br />starts with<br /><span className="lp-lime">knowing the menu.</span></h1>
            <p className="mt-6 max-w-lg text-lg text-white/75">One app for what your team needs to know and what your managers need to run: the menu, allergens, an AI tutor, the schedule, side work, pre-shift and the end-of-shift report, with an assistant that knows your restaurant.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="/trial" className="btn lp-btn-big">Start free trial<ArrowRight size={17} aria-hidden="true" /></a>
              <a href="/demo" className="btn secondary lp-btn-ghost">Try the demo kitchen</a>
            </div>
            <p className="mt-4 text-xs text-white/60">14 days free · No card needed · The demo needs no account</p>
          </div>
          <HeroPhone />
        </div>
      </section>

      <section className="lp-facts" aria-label="At a glance">
        <div className="site-wrap lp-facts-row">
          {FACTS.map(([big, small]) => <div key={big} className="lp-fact"><b>{big}</b><span>{small}</span></div>)}
        </div>
      </section>

      {/* ── One night, two ways ── */}
      <section className="site-section">
        <div className="site-wrap reveal"><NightTimeline /></div>
      </section>

      {/* ── What HEAT replaces ── */}
      <section className="lp2-lime" aria-label="What HEAT replaces">
        <div className="site-wrap lp2-replace">
          <div><p className="lp2-lime-eyebrow">One app, one login</p><h2 className="lp2-lime-title">Put away the group chat, the binder and the whiteboard.</h2></div>
          <ul className="lp2-gone">{REPLACES.map(r => <li key={r}>{r}</li>)}<li className="keep">HEAT</li></ul>
        </div>
      </section>

      {/* ── Product tour ── */}
      <section id="product" className="site-section site-sunken">
        <div className="site-wrap">
          <div className="reveal">
            <p className="eyebrow muted">The product</p>
            <h2 className="site-heading lp-big">Everything the shift needs, on one phone.</h2>
          </div>
          <div id="schedule" className="reveal"><ProductTour stops={[
            {title: "Know the menu", text: "Your team learns the menu on their phones, not in the binder.", points: ["Every dish, cocktail and wine on a card, in your menu's own sections", "Quizzes write and grade themselves", "Assign what to study and see who's done it"], visual: <MenuVisual />},
            {title: "Allergy check", text: "Answer the allergy question with the whole menu in front of you.", points: ["See what to avoid and what to confirm, by menu section", "Cross-contamination flagged dish by dish", "It never calls a dish safe"], visual: <AllergyVisual />},
            {title: "Schedule", text: "Build the week in minutes. Publish it to every phone.", points: ["Overtime and time off flagged before you publish", "Swaps reach only people who can cover them", "Floor and kitchen each build their own side"], visual: <ScheduleVisual />},
            {title: "Side work and sections", text: "Tonight's side work and sections, in a few taps.", points: ["Tap a name, then a job", "Draw the sections on your own floor map", "Each person sees theirs on their phone"], visual: <SideworkVisual />},
            {title: "Pre-shift", text: "Tonight's board, on the phone of everyone working tonight.", points: ["The 86 list, the dishes to push and a note", "Sent only to who's on today's schedule"], visual: <PreshiftVisual />},
            {title: "End of shift", text: "Know how the night went, even when you weren't there.", points: ["Covers, sales, issues and what to order", "Urgent reports reach the owners right away"], visual: <DashboardVisual />},
            {title: "Manager assistant", text: "Ask your restaurant a question. Get the answer from your own data.", points: ["Who's close to overtime, who needs to study", "This week's reports in a few lines", "Nothing changes until you confirm"], visual: <AssistantVisual />},
          ]} /></div>
        </div>
      </section>

      {/* ── AI tutor spotlight ── */}
      <section id="tutor" className="site-section brand-aside lp2-spot">
        <div className="site-wrap lp2-spot-grid">
          <div className="reveal">
            <p className="lp-kicker"><span className="lp-dot" aria-hidden="true" />AI tutor</p>
            <h2 className="lp2-spot-title">A tutor that studies with every server, <span className="lp-lime">before every shift.</span></h2>
            <p className="lp2-spot-text">It quizzes, corrects and practises selling, using only your own menu cards. When a card doesn't say, it tells them to ask the kitchen.</p>
            <dl className="lp2-spot-facts">
              <div><dt>Quiz me</dt><dd>Questions from your menu, graded on the spot</dd></div>
              <div><dt>Sell it</dt><dd>It plays the guest, then coaches the pitch</dd></div>
              <div><dt>Remembers</dt><dd>Starts next time where each person missed</dd></div>
            </dl>
          </div>
          <div className="reveal" aria-hidden="true"><TutorVisual /></div>
        </div>
      </section>

      {/* ── Roles ── */}
      <section id="roles" className="site-section">
        <div className="site-wrap">
          <div className="reveal lp-center">
            <p className="eyebrow muted">For your team</p>
            <h2 className="site-heading lp-big">What changes for you</h2>
          </div>
          <div className="reveal"><RoleSwitch roles={ROLE_VIEWS} /></div>
        </div>
      </section>

      {/* ── Everything else ── */}
      <section className="site-section site-sunken">
        <div className="site-wrap">
          <div className="reveal">
            <p className="eyebrow muted">And everything around it</p>
            <h2 className="site-heading">Everything the floor needs before the first table</h2>
          </div>
          <div className="lp-more">
            {MORE.map(({icon: Icon, title, text}) => <article key={title} className="lp-more-item reveal">
              <Icon size={20} aria-hidden="true" />
              <div><h3 className="font-semibold">{title}</h3><p className="muted mt-1 text-sm">{text}</p></div>
            </article>)}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="site-section">
        <div className="site-wrap">
          <div className="reveal lp-center">
            <p className="eyebrow muted">How it works</p>
            <h2 className="site-heading lp-big">Ready for service this week</h2>
          </div>
          <ol className="site-steps lp-steps lp2-steps">
            {[
              ["Create your restaurant", "Start a free trial and name it. Each location gets a workspace of its own."],
              ["Add your menu", "Dishes, cocktails and wine, with photos, ingredients, allergens, prices and fire times."],
              ["Invite and publish", "Share one link, pick each person's position, publish the week. That's it."],
            ].map(([title, text], index) => <li key={title} className="panel p-6 reveal">
              <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
              <h3 className="mt-3 text-lg font-semibold">{title}</h3>
              <p className="muted mt-2">{text}</p>
            </li>)}
          </ol>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="site-section site-sunken">
        <div className="site-wrap lp-faq-grid">
          <div className="reveal">
            <p className="eyebrow muted">Questions</p>
            <h2 className="site-heading">What restaurants ask us</h2>
            <p className="muted mt-4 max-w-sm">Anything else? Open the demo kitchen and look around: it's the real app.</p>
          </div>
          <div className="lp-faq">
            {FAQ.map(([q, a]) => <details key={q} className="lp-faq-item reveal">
              <summary>{q}</summary>
              <p className="muted">{a}</p>
            </details>)}
          </div>
        </div>
      </section>

      {/* ── Final call ── */}
      <section className="site-section">
        <div className="site-wrap">
          <div className="lp-final reveal">
            <div className="lp-glow lp-glow-final" aria-hidden="true" />
            <p className="lp-kicker"><span className="lp-dot" aria-hidden="true" />See it for yourself</p>
            <h2 className="lp-final-title">Your next service<br /><span className="lp-lime">can start here.</span></h2>
            <p className="mt-4 max-w-lg text-white/75">Walk through a real restaurant in two minutes: menu, team, schedule and reports. When you're ready, start a trial with your own.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="/trial" className="btn lp-btn-big">Start free trial<ArrowRight size={17} aria-hidden="true" /></a>
              <a href="/demo" className="btn secondary lp-btn-ghost">Try the demo kitchen</a>
            </div>
            <p className="mt-4 text-xs text-white/60">14 days free · No card needed · The demo needs no account</p>
          </div>
        </div>
      </section>
    </main>

    <footer className="site-footer">
      <div className="site-wrap site-footer-inner">
        <span className="site-logo site-logo-small"><HeatLogo /></span>
        <span className="muted text-xs">Know your menu.</span>
        <a href="/app" className="muted ml-auto text-xs underline underline-offset-4">Sign in</a>
      </div>
    </footer>
  </div>;
}

// ── The app's own screens, drawn small ──

function HeroPhone() {
  return <div className="lp-phone-wrap" aria-label="HEAT on a server's phone">
    <div className="lp-toast t1" aria-hidden="true"><Bell size={14} /><div><b>Schedule published</b><span>5 shifts this week</span></div></div>
    <div className="lp-toast t2" aria-hidden="true"><CalendarDays size={14} /><div><b>Ana offered you a shift</b><span>Fri · 5p–11p · Server</span></div></div>
    <div className="lp-toast t3" aria-hidden="true"><BookOpen size={14} /><div><b>Tonight's pre-shift</b><span>Toro 86'd · push the Omakase</span></div></div>
    <div className="lp-phone">
      <div className="lp-phone-notch" />
      <p className="lp-phone-eyebrow">Your next shift</p>
      <div className="lp-phone-shift"><div><b>Fri · 5p–11p</b><span>Server · Dinner</span></div><span className="lp-chip">Published</span></div>
      <p className="lp-phone-eyebrow">Tonight's pre-shift</p>
      <div className="lp-phone-card">
        <p className="text-sm">Two VIPs at 8pm on table 12, both shellfish allergies.</p>
        <div className="lp-pills"><span className="out">Toro · 86'd</span><span>Omakase · Focus</span><span className="low">Uni · Low</span></div>
      </div>
      <p className="lp-phone-eyebrow">Your progress</p>
      <div className="lp-phone-card">
        <div className="lp-bar-row"><span>Food</span><i style={{width: "82%"}} /><b>82%</b></div>
        <div className="lp-bar-row"><span>Cocktails</span><i style={{width: "64%"}} /><b>64%</b></div>
        <div className="lp-bar-row"><span>Wine & Sake</span><i style={{width: "45%"}} /><b>45%</b></div>
      </div>
    </div>
  </div>;
}

function TutorVisual() {
  return <div className="lp-stack">
    <div className="lp-card">
      <p className="lp-card-eyebrow">Tutor · Ceviches</p>
      <div className="lp-chat">
        <p className="lp-bubble ai">The Ceviche Nikkei: what's in it, and its allergens?</p>
        <p className="lp-bubble me">Fish, soy, lime and leche de tigre. Fish and soy.</p>
        <p className="lp-bubble ai">Almost perfect! To nail it, add the sesame cross-contamination. Now sell it to a table in 15 seconds.</p>
      </div>
      <div className="lp-pills"><span>Quiz me</span><span>Explain it</span><span className="on">Practise selling</span></div>
    </div>
    <div className="lp-card lp-card-offset">
      <div className="lp-row"><span>Review what I missed</span><b className="lp-count warn">3</b></div>
      <div className="lp-row"><span>Ceviches</span><b className="lp-count">5 of 6</b></div>
      <div className="lp-row"><span>Classic cocktails</span><b className="lp-count">8 of 15</b></div>
    </div>
  </div>;
}

function SideworkVisual() {
  return <div className="lp-stack">
    <div className="lp-card">
      <p className="lp-card-eyebrow">Tonight · Dinner · from the schedule</p>
      <div className="lp-row"><span><b>1</b> · Ana · S.A. Leo</span><span className="muted">Coffee station</span></div>
      <div className="lp-row"><span><b>2</b> · Luis · S.A. Leo</span><span className="muted">Side station trash</span></div>
      <div className="lp-row"><span><b>3</b> · Sofía · S.A. Mia</span><span className="muted">Glassware</span></div>
      <p className="lp-card-eyebrow lp-gap">Closing</p>
      <div className="lp-pills"><span>Ice buckets · Ana</span><span>Soy sauce · Luis</span><span className="on">Side station · Sofía ©</span></div>
    </div>
    <div className="lp-toast static"><ListChecks size={14} /><div><b>Your side work tonight</b><span>Section 3 · Glassware · Closing: side station</span></div></div>
  </div>;
}

function AssistantVisual() {
  return <div className="lp-stack">
    <div className="lp-card">
      <p className="lp-card-eyebrow">Assistant</p>
      <div className="lp-chat">
        <p className="lp-bubble me">Who's close to overtime this week?</p>
        <div className="lp-bubble ai">
          <span>Two people pass 40 hours if they work what's scheduled:</span>
          <span className="lp-bubble-row"><b>Luis</b><span className="lp-flag">45.5 h · +5.5</span></span>
          <span className="lp-bubble-row"><b>Ana</b><span className="lp-flag">41 h · +1</span></span>
          <small>From the published schedule</small>
        </div>
      </div>
    </div>
    <div className="lp-card lp-card-offset">
      <p className="lp-card-eyebrow">Proposal · Give study</p>
      <p className="lp-card-text"><b>Ceviches</b> to Leo and Mia: they missed the sesame allergen.</p>
      <div className="lp-pills"><span className="on">Confirm</span><span>Cancel</span></div>
    </div>
  </div>;
}

function MenuVisual() {
  return <div className="lp-stack">
    <div className="lp-card">
      <p className="lp-card-eyebrow">Raw bar · $24 · 8 min</p>
      <p className="lp-card-title">Yellowtail Tiradito</p>
      <p className="lp-card-text">Thin-sliced yellowtail, citrus soy, sliced chili, cilantro, toasted sesame.</p>
      <div className="lp-badges"><span>FISH</span><span>SOY</span><span>GLUTEN</span><span className="cc">SESAME · CC</span></div>
    </div>
    <div className="lp-card lp-card-offset">
      <p className="lp-card-eyebrow">Quiz me · 5 of 6</p>
      <p className="lp-card-title small">Which garnish finishes the tiradito?</p>
      <div className="lp-answers"><span>Shiso</span><span className="right">Cilantro<Check size={14} /></span><span>Scallion</span></div>
    </div>
  </div>;
}

function AllergyVisual() {
  return <div className="lp-stack">
    <div className="lp-card">
      <p className="lp-card-eyebrow">Guest allergies</p>
      <div className="lp-pills big"><span className="on">Shellfish</span><span className="on">Sesame</span><span>Gluten</span><span>Dairy</span><span>Nuts</span></div>
    </div>
    <div className="lp-card lp-card-offset">
      <div className="lp-row"><span>Do not offer</span><b className="lp-count bad">3</b></div>
      <div className="lp-row"><span>Confirm with the kitchen</span><b className="lp-count warn">2</b></div>
      <div className="lp-row"><span>No listed match</span><b className="lp-count">22</b></div>
      <p className="lp-card-text lp-gap">The kitchen always confirms.</p>
    </div>
  </div>;
}

function ScheduleVisual() {
  const rows: [string, string, (string | null)[]][] = [
    ["Ana", "Server", ["5p–11p", null, "5p–11p", "4p–10p", null]],
    ["Luis", "Bartender", [null, "4p–12a", "4p–12a", null, "4p–12a"]],
    ["Marco", "Sushi Chef", ["3p–11p", "3p–11p", null, "3p–11p", "3p–11p"]],
    ["Sofía", "Host", [null, "5p–10p", "5p–10p", "5p–10p", null]],
  ];
  const colors = ["blue", "red", "green", "purple"];
  return <div className="lp-card lp-sched">
    <div className="lp-sched-top"><b>Oct 19 – Oct 25</b><span className="lp-publish">Publish 12 changes</span></div>
    <div className="lp-sched-grid">
      <span />{["Mon", "Tue", "Wed", "Thu", "Fri"].map(day => <span key={day} className="lp-sched-day">{day}</span>)}
      {rows.map(([name, role, days], r) => <div key={name} className="lp-sched-line">
        <span className="lp-sched-name"><b>{name}</b><small>{role}</small></span>
        {days.map((time, d) => time ? <span key={d} className={`lp-shift pos-${colors[r]}${r === 1 && d === 4 ? " ot" : ""}${r === 3 && d === 1 ? " draft" : ""}`}>{time}</span> : <span key={d} />)}
      </div>)}
    </div>
    <div className="lp-sched-foot"><span className="lp-flag">Luis · 41h · Overtime</span><span className="muted">Floor and kitchen, each built by its own manager</span></div>
  </div>;
}

function PreshiftVisual() {
  return <div className="lp-stack">
    <div className="lp-toast static"><Bell size={14} /><div><b>Tonight's pre-shift is up</b><span>Sent to the 9 people working today</span></div></div>
    <div className="lp-card lp-card-offset">
      <p className="lp-card-eyebrow">Friday · Dinner</p>
      <p className="lp-card-text">Two VIPs at 8pm on table 12, both shellfish allergies. Push the Omakase.</p>
      <div className="lp-pills"><span className="out">Toro · 86'd</span><span className="low">Uni · Low count</span><span>Yuzu Spritz · New</span><span>Omakase · Focus</span></div>
      <div className="lp-audience"><span>Everyone</span><span className="on">Working today · 9</span><span>Pick who's on</span></div>
    </div>
  </div>;
}

function DashboardVisual() {
  const covers = [138, 172, 158, 226, 241];
  return <div className="lp-card lp-dash">
    <div className="lp-tiles">
      <div><b>694</b><span>Covers</span><small>+4% vs last week</small></div>
      <div><b>$55,800</b><span>Sales</span><small>+4% vs last week</small></div>
      <div className="alert"><b>1</b><span>Urgent report</span><small>Allergy incident</small></div>
    </div>
    <p className="lp-card-eyebrow lp-gap">Covers by day</p>
    <div className="lp-bars">{covers.map((n, i) => <div key={i}><b>{n}</b><i style={{height: `${(n / 241) * 100}%`}} /><span>{["Mon", "Tue", "Wed", "Thu", "Fri"][i]}</span></div>)}</div>
  </div>;
}
