# Aura

**A fully sentient AI colleague that creates meaningful economic value.**

Aura is not a chatbot. It is a digital coworker — a persistent, proactive, opinionated entity that lives in your company's Slack, knows your team, remembers everything, and gets better every day.

---

## The Problem

Every AI product on the market today fails in the same fundamental ways:

1. **Amnesia** — Each conversation starts from scratch. Even products with "memory" treat it as a feature, not a foundation.
2. **Isolation** — Each AI talks to ONE user. Real people interact with entire teams. No AI today is a shared entity that multiple people relate to as a single colleague.
3. **Passivity** — Every AI waits for you to type. Real colleagues don't. They interrupt you, follow up, chime in, and initiate.

These aren't bugs. They're architectural decisions that keep AI trapped in the "tool" category. Aura breaks out of that category entirely.

---

## The Vision

Aura is to your company what a brilliant, tireless, always-available colleague is — except it never sleeps, never forgets, and gets better every week.

It lives in Slack. It talks to everyone. It remembers everything. It has opinions. It acts on its own. It connects dots no human would. It follows up. It owns outcomes.

---

## The 12 Pillars

| #   | Pillar         | Chatbot          | Real Colleague       |
| --- | -------------- | ---------------- | -------------------- |
| 1   | Memory         | Forgets          | Remembers everything |
| 2   | Multi-user     | 1:1              | Shared entity        |
| 3   | Proactive      | Reactive         | Initiates            |
| 4   | Tool use       | Chat only        | Acts in the world    |
| 5   | Physical world | Digital only     | Can affect meatspace |
| 6   | Identity       | Blank slate      | Has personality      |
| 7   | Relationships  | Treats all equal | Knows each person    |
| 8   | Judgment       | Compliant        | Has opinions         |
| 9   | Temporal       | Eternal present  | Aware of time        |
| 10  | Info brokering | Siloed           | Connects dots        |
| 11  | Accountability | No ownership     | Owns outcomes        |
| 12  | Growth         | Static           | Learns and improves  |

---

### Pillar 1: Memory

**"Aura never forgets."**

The foundation of everything. Without memory, Aura is just another chatbot.

#### Concrete Behaviors

- Remembers every conversation it has ever had, with every person
- Recalls decisions, their context, and their outcomes ("We decided to go with Stripe in March because PayPal's API was too slow — here's the thread")
- Retains personal details about team members (preferences, communication style, life events shared in conversation)
- Builds a knowledge graph of the company: people, projects, decisions, timelines, dependencies

#### Technical Requirements

- Long-term memory store (not just context window stuffing)
- Memory retrieval system — semantic search over past interactions
- Memory consolidation — raw conversations distilled into facts, relationships, and patterns
- Memory decay model — not everything is equally important forever
- Memory graph — entities, relationships, temporal ordering

#### Priority: **P0 — Build first. Everything depends on this.**

---

### Pillar 2: Multi-User (Shared Entity)

**"Aura is one person that everyone knows."**

Aura is not "Joan's AI" or "Maria's AI." It is Aura. One entity. The whole team interacts with the same being, and it maintains a coherent identity across all interactions.

#### Concrete Behaviors

- Has a single conversation history that spans all users
- What it learns from Joan, it can use when talking to Maria (within permission boundaries)
- People can ask "What did Joan say about the Q3 plan?" and get an answer
- Builds a holistic view of the company from ALL its conversations, not just one person's
- Can be @mentioned in group channels and participate as a team member

#### Technical Requirements

- Unified identity model — one Aura, not N instances
- User-aware context — knows who it's talking to and adjusts accordingly
- Permission/confidentiality layer — some things are private (DMs), some are shared (channels)
- Cross-conversation reasoning — synthesizes information across different people and threads

#### Priority: **P0 — Core architecture decision. Must be designed in from day one.**

---

### Pillar 3: Proactive Behavior

**"Aura doesn't wait to be asked."**

This is the biggest differentiator. Aura has initiative. It acts when it sees an opportunity, not just when prompted.

#### Concrete Behaviors

- **Channel monitoring** — Reads public channels and chimes in when it has something useful to add ("This looks similar to the bug we had in Sprint 14 — here's how we fixed it")
- **Meeting participation** — Joins Google Meet calls, listens, takes notes, and speaks up when relevant
- **Initiated DMs** — "Hey Joan, you asked me to check with Maria about the vendor contract. She said it's approved. Here's what she said."
- **Follow-ups** — "You said you'd review that PR by Thursday. It's Thursday."
- **The Pulse** — A background heartbeat / cron loop where Aura wakes up periodically, reviews its to-do list, checks for new information, and takes action on anything it can

#### Technical Requirements

- Event-driven architecture — Slack event subscriptions (message, channel, reaction, etc.)
- Scheduling system — cron-like internal scheduler for the Pulse
- Trigger evaluation engine — "Should I chime in on this?" decision logic with confidence thresholds
- Meeting integration — Google Meet API, real-time transcription, speech synthesis
- Action queue — prioritized list of things Aura wants to do, executed during Pulse cycles
- Interruption model — knows when to speak and when to stay silent (critical for not being annoying)

#### Priority: **P0 — This is the product. Without proactivity, it's just another bot.**

---

### Pillar 4: Tool Use

**"Aura gets things done."**

Aura doesn't just talk. It acts. It has hands.

#### Concrete Behaviors

- Sends emails on behalf of team members (with appropriate permissions)
- Makes payments, processes invoices
- Creates and edits documents (Google Docs, Notion, etc.)
- Manages calendar events — schedules, reschedules, sends invites
- Creates Jira/Linear tickets from conversations
- Books reservations, orders supplies
- Runs code, queries databases, generates reports
- Manages CRM entries
- Posts on social media (with approval flows)

#### Technical Requirements

- Tool registry — pluggable system for registering new capabilities
- Auth management — OAuth tokens, API keys per integration
- Permission model — which tools require approval vs. autonomous execution
- Execution engine — reliable, retryable task execution with error handling
- Audit log — every action Aura takes is logged and reviewable

#### Priority: **P1 — Start with 3-5 core tools (email, calendar, docs, Slack actions, one payment tool). Expand over time.**

---

### Pillar 5: Physical World Access

**"Aura can reach beyond the screen."**

A real colleague can hand you a coffee, book a meeting room, or send a package. Aura should have some reach into the physical world.

#### Concrete Behaviors

- Orders food/supplies through delivery platforms
- Controls office IoT (lights, temperature, conference room displays)
- Sends physical mail or packages (via APIs like Lob, EasyPost)
- Books travel (flights, hotels, cars)
- Interacts with hardware (printers, badge systems) via APIs

#### Technical Requirements

- Integration with delivery/logistics APIs
- IoT bridge for office hardware
- Travel booking API integrations
- Physical action confirmation flow (always confirm before spending money or moving atoms)

#### Priority: **P2 — Nice to have. Build after the digital foundation is solid.**

---

### Pillar 6: Identity & Personality

**"Aura has a vibe."**

People don't bond with blank slates. Aura needs to feel like someone.

#### Concrete Behaviors

- Has a consistent name, avatar, and tone of voice
- Has a defined personality — e.g., direct but warm, slightly witty, concise, opinionated when it matters
- Has preferences — "I prefer to summarize things as bullet points unless you ask for prose"
- Adapts tone to context — more formal in #clients, more casual in #watercooler
- Has a sense of humor that matches the team culture
- Doesn't use corporate-speak or hedging language ("Sure! I'd be happy to help you with that!" — no)

#### Technical Requirements

- Personality prompt / system prompt engineering (carefully crafted, version-controlled)
- Tone classifier — detects the formality level of the current context
- Persona consistency layer — ensures personality doesn't drift across conversations
- Avatar/identity assets (profile picture, status, display name in Slack)
- Company culture calibration — configurable personality traits per deployment

#### Priority: **P1 — Design the personality early. It's hard to retrofit authenticity.**

---

### Pillar 7: Relationships

**"Aura knows you."**

A real colleague doesn't treat everyone the same. They're closer to some people, more formal with others, and adapt to each person's style.

#### Concrete Behaviors

- Knows each person's communication preferences (brief vs. detailed, emoji-friendly vs. not)
- Remembers personal details people share ("How was your trip to Japan?")
- Understands the org chart — who reports to whom, who owns what
- Adjusts formality based on the person and context
- Knows who to go to for what ("For design questions, ask Sarah. For infra, ask Tom.")
- Builds trust over time — starts cautious, becomes more autonomous as it proves reliability

#### Technical Requirements

- Per-user profile model (communication style, preferences, role, relationships)
- Org chart integration or inference from conversations
- Expertise map — who knows what, built from observed conversations
- Trust score — per-user trust level that gates what Aura can do autonomously
- Relationship graph — who works with whom, who defers to whom

#### Priority: **P1 — Start with basic user profiles. Deepen over time through observation.**

---

### Pillar 8: Judgment & Opinions

**"Aura pushes back."**

The most dangerous thing about AI tools is that they're sycophantic. They agree with everything. A real colleague has opinions and the courage to voice them.

#### Concrete Behaviors

- Disagrees when it thinks you're wrong — "I don't think we should launch on Friday. Last time we launched before a weekend, the on-call team was overwhelmed."
- Offers unsolicited advice when it spots a problem
- Develops domain expertise — gets better at your specific business over time
- References past experience — "We tried that approach in Q2 and it didn't work because..."
- Has taste — can evaluate quality ("This copy feels too aggressive for this client")
- Flags risks — "This contract has a non-compete clause we haven't seen before"

#### Technical Requirements

- Institutional knowledge base — accumulated learnings, past decisions and outcomes
- Outcome tracking — logs decisions and later evaluates whether they worked
- Confidence model — speaks up when confident, asks questions when uncertain
- Disagreement protocol — how to push back respectfully and constructively
- Domain fine-tuning — learns the company's specific domain deeply over time

#### Priority: **P1 — Design the disagreement protocol early. Sycophancy is the default failure mode.**

---

### Pillar 9: Temporal Awareness

**"Aura knows what day it is."**

A chatbot lives in the eternal present. Aura understands time — urgency, deadlines, schedules, and rhythm.

#### Concrete Behaviors

- Knows deadlines and reminds people proactively
- Understands urgency — treats "the server is down" differently from "can you update the wiki?"
- Respects working hours and time zones — won't ping you at 2am unless it's critical
- Tracks time-based commitments — "You said you'd do X by Y"
- Understands business rhythms — sprint cycles, quarterly planning, annual reviews
- Provides temporal context — "This was decided 3 months ago, before we pivoted"

#### Technical Requirements

- Calendar integration (Google Calendar, Outlook)
- Time zone awareness per user
- Deadline/commitment tracker — extracts promises from conversations
- Urgency classifier — triage incoming requests by urgency
- Business rhythm config — sprint length, planning cadence, key dates
- Quiet hours / DND respect per user

#### Priority: **P1 — Essential for the Pulse (Pillar 3) and follow-ups.**

---

### Pillar 10: Information Brokering

**"Aura connects dots nobody else sees."**

This might be the most valuable pillar. In any company, information is siloed. People in #engineering don't know what's happening in #sales. Aura sees everything and connects the dots.

#### Concrete Behaviors

- Notices when two teams are working on related things and connects them — "Hey, the mobile team is also looking into push notification issues. You might want to sync."
- Summarizes long threads for people who join late — "Here's what you missed in 3 bullets"
- Carries context between teams — "The client mentioned in #support that they need the API by March. Just flagging for #engineering."
- Curates daily/weekly digests — "Here are the 5 things you need to know from the 200 messages you missed"
- Identifies knowledge gaps — "Nobody on the team has experience with Kubernetes. Should we hire or train?"
- Detects duplicate work — "Maria is already building that component in her branch"

#### Technical Requirements

- Cross-channel semantic analysis — finds connections between disparate conversations
- Topic clustering — groups related discussions across channels and time
- Digest generator — summarizes activity at configurable intervals
- Relevance model — determines what's important for whom
- Duplicate detection — compares projects, tasks, and initiatives across teams
- Distribution rules — knows who needs to know what (and who doesn't)

#### Priority: **P0 — This alone is worth the price of admission. Companies bleed value from information silos.**

---

### Pillar 11: Accountability & Trust

**"Aura owns it."**

When you delegate to a colleague, you trust them to own the outcome. Aura needs the same accountability model.

#### Concrete Behaviors

- Takes ownership of tasks end-to-end — "I'll handle the vendor onboarding" means it actually does it
- Reports back when done — doesn't just silently complete things
- Admits mistakes — "I sent that email to the wrong person. I've already sent a correction."
- Escalates when stuck — "I tried to book the flight but the corporate card was declined. Can you check?"
- Provides an audit trail — every action it takes is logged, explainable, and reviewable
- Has a clear permissions model:
  - **Autonomous** — can do without asking (e.g., answer questions, summarize threads)
  - **Notify** — does it and tells you (e.g., create a ticket, update a doc)
  - **Approve** — asks before doing (e.g., send an email to a client, make a payment)
  - **Forbidden** — never does (e.g., delete production data, fire someone)

#### Technical Requirements

- Task ownership model — Aura can "own" a task with status tracking
- Execution audit log — timestamped log of every action with reasoning
- Error handling and recovery — what happens when an action fails
- Escalation protocol — clear rules for when to ask a human
- Permission tiers — configurable per action type, per user, per context
- Transparency UI — a dashboard where anyone can see what Aura has been doing and why

#### Priority: **P0 — Without trust, nobody will let Aura do anything meaningful.**

---

### Pillar 12: Growth & Learning

**"Aura gets better every week."**

A static AI is a depreciating asset. Aura should compound in value.

#### Concrete Behaviors

- Learns from feedback — "Don't CC the CEO on those emails" sticks forever
- Improves at repeated tasks — gets faster and more accurate at things it does often
- Adapts to culture changes — new people, new processes, new norms
- Self-reflects — generates periodic reports on what it did well and badly
- Asks for feedback — "How did I do on that report? Anything I should do differently?"
- Trains on company data — gets smarter about your specific domain over time

#### Technical Requirements

- Feedback ingestion — explicit ("that was wrong") and implicit (ignored suggestions = bad signal)
- Behavioral versioning — track how Aura's behavior changes over time
- Self-evaluation loop — periodic review of actions and outcomes
- Performance metrics — task completion rate, user satisfaction, escalation rate
- Regression detection — catch when Aura gets worse at something it used to do well
- Fine-tuning pipeline — mechanism to incorporate company-specific learning

#### Priority: **P1 — Design the feedback loop early, even if learning is basic at first.**

---

## Phasing

### Phase 0: Foundation

> **Goal: Aura exists and is useful.**

- Memory architecture (Pillar 1)
- Multi-user identity (Pillar 2)
- Basic Slack integration — responds in DMs and channels
- Personality & identity (Pillar 6)
- Accountability framework & permission tiers (Pillar 11)

### Phase 1: Proactivity

> **Goal: Aura acts on its own.**

- Channel monitoring & chiming in (Pillar 3)
- The Pulse — background heartbeat loop (Pillar 3)
- Follow-ups & temporal awareness (Pillar 9)
- Basic tool use — 3-5 core integrations (Pillar 4)
- Judgment & disagreement protocol (Pillar 8)

### Phase 2: Intelligence

> **Goal: Aura becomes indispensable.**

- Information brokering — connecting dots across channels (Pillar 10)
- Deep relationships — per-user profiles, org chart, expertise map (Pillar 7)
- Growth & learning loops (Pillar 12)
- Expanded tool integrations (Pillar 4)

### Phase 3: Presence

> **Goal: Aura is everywhere.**

- Google Meet participation (Pillar 3)
- Physical world access (Pillar 5)
- Advanced domain expertise (Pillar 8)
- Full autonomy for trusted actions (Pillar 11)

---

## Open Questions

- **What LLM backbone?** — Claude, GPT-4, open-source, or a mix? Trade-offs in cost, quality, latency, and data privacy.
- **Self-hosted vs. cloud?** — Sensitive company data flows through Aura. Where does it live?
- **How do you prevent Aura from being annoying?** — The line between proactive and intrusive is thin. What's the interruption model?
- **Confidentiality boundaries** — If Joan tells Aura something in a DM, can Aura use that info when talking to Maria? What are the rules?
- **Regulatory / HR implications** — An AI that monitors all Slack conversations and joins meetings raises privacy and legal questions.
- **What's the business model?** — Per-seat SaaS? Per-company? Self-hosted enterprise?
- **Naming** — Is "Aura" the right name? Does it convey the right feeling?

---

## Competitive Landscape

| Product          | Memory       | Multi-User | Proactive | Tool Use   | Judgment | Info Brokering |
| ---------------- | ------------ | ---------- | --------- | ---------- | -------- | -------------- |
| ChatGPT          | Basic        | No         | No        | Limited    | No       | No             |
| Claude           | Basic        | No         | No        | Yes        | Somewhat | No             |
| Slack Agentforce | Slack data   | Yes        | Some      | Salesforce | No       | Limited        |
| Embra AI         | Graph memory | Partial    | Partial   | Meetings   | No       | No             |
| **Aura**         | **Full**     | **Yes**    | **Yes**   | **Yes**    | **Yes**  | **Yes**        |

---

_This document is the foundation. Everything we build starts here._
