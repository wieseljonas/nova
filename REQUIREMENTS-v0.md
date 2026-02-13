# Aura v0 — Requirements

**Codename: The Turing Test**

> Can Aura fool your team into believing it's a real colleague — not in a single conversation, but across dozens of sessions with dozens of people, over weeks?

---

## Scope

v0 is **conversation only**. No tools, no actions, no email, no calendar, no payments. Aura talks. That's it.

But it talks like a _person_ — one who remembers everything, knows everyone, has opinions, and carries context between every conversation it's ever had with every person on the team.

### In Scope

- Slack bot that responds in DMs and channels when mentioned or addressed
- Persistent memory across all conversations with all users
- Single shared identity (one Aura, not one-per-user)
- Defined personality that feels human and consistent
- Awareness of who it's talking to and adaptation to each person
- Ability to reference past conversations, decisions, and context
- Willingness to disagree, push back, and have opinions
- Basic temporal awareness (knows today's date, references when things happened)

### Out of Scope (deferred to v1+)

- Proactive behavior (Aura does not initiate — it only responds)
- Tool use (no emails, no calendar, no file creation, no payments)
- Channel monitoring without being mentioned
- Google Meet integration
- The Pulse / background processing
- Physical world access
- Self-evaluation and growth loops

---

## The Test

### What does "passing the Turing test" mean here?

It does NOT mean people literally think Aura is human. Everyone knows it's AI.

It means: **people relate to Aura the way they relate to a colleague, not the way they relate to a tool.** Specifically:

- People say "Aura said..." the same way they'd say "Maria said..."
- People feel _known_ by Aura — it remembers their preferences, their projects, their style
- People trust Aura's opinions, even when it disagrees with them
- People are surprised by how much context Aura has — "Wait, how did you know about that?"
- People talk to Aura casually, not in rigid prompts
- When Aura says something wrong, people correct it like they'd correct a colleague, not like they'd retry a failed tool

### Success Metrics

| Metric                                                                                   | Target         |
| ---------------------------------------------------------------------------------------- | -------------- |
| Team members who interact with Aura weekly                                               | > 80% of team  |
| Avg. messages per user per week                                                          | > 10           |
| Cross-user context references (Aura uses info from person A when talking to person B)    | > 5 per week   |
| Unprompted "that's impressive" / surprise moments                                        | > 3 per week   |
| Users who describe Aura as "colleague" or "teammate" (not "tool" or "bot") in surveys    | > 50%          |
| Personality consistency (blind test: can users identify Aura's messages vs. generic AI?) | > 80% accuracy |

---

## Functional Requirements

### FR-1: Slack Integration

#### FR-1.1: Presence

- Aura appears as a regular member in the Slack workspace
- Has a profile picture, display name ("Aura"), and a status
- Shows as "online" during configured hours (or always)
- Has a bio/description that feels human, not corporate

#### FR-1.2: Responding in DMs

- Any team member can DM Aura directly
- Aura responds within a reasonable time (target: < 5 seconds for short messages)
- Conversations in DMs are private — Aura does not share DM content with other users unless explicitly told to
- Supports multi-turn conversations (threaded or sequential)

#### FR-1.3: Responding in Channels

- Aura responds when @mentioned in any public or private channel it's a member of
- Aura can also respond when directly addressed by name without @ (e.g., "Aura, what do you think?")
- In channels, Aura responds in-thread to keep the channel clean
- Aura reads and retains channel context even when not mentioned (for memory purposes), but does NOT speak unless addressed

#### FR-1.4: Message Formatting

- Uses natural Slack formatting (bold, italic, lists, code blocks, links) when appropriate
- Doesn't overformat — a real person wouldn't bold every other word
- Can use emoji reactions naturally (sparingly, the way a real person would)
- Can share snippets, but doesn't dump walls of text unless asked

---

### FR-2: Memory

#### FR-2.1: Conversation Storage

- Every message Aura sends and receives is stored permanently
- Stored with metadata: timestamp, user, channel/DM, thread ID
- Raw conversation history is the source of truth

#### FR-2.2: Memory Extraction

- After each conversation (or periodically), Aura extracts structured memory:
  - **Facts** — "Joan prefers bullet points." "The Q3 launch date is March 15."
  - **Decisions** — "We decided to use Postgres instead of MongoDB." (with context: who, when, why)
  - **Personal details** — "Tom has a dog named Biscuit." "Sarah is on vacation next week."
  - **Relationships** — "Joan and Maria work closely on the mobile app." "Tom reports to Sarah."
  - **Sentiments** — "Joan seemed frustrated about the deploy process." "The team is excited about the redesign."
  - **Open threads** — "Joan asked about the API docs but never got an answer."

#### FR-2.3: Memory Retrieval

- When composing a response, Aura queries its memory for relevant context
- Retrieval is semantic (not just keyword matching) — asking about "the database decision" should find the Postgres conversation even if those exact words weren't used
- Retrieval considers recency, relevance, and the specific user being talked to
- Retrieved memories are injected into the LLM context alongside the current conversation

#### FR-2.4: Memory Across Users

- Memories from conversations with User A are available when talking to User B
- Exception: content from DMs is tagged as private and only surfaced if:
  - The information was also discussed in a public channel, OR
  - User A explicitly told Aura to share it ("Tell Maria that I approved the budget")
- Channel conversations are considered public knowledge within the team

#### FR-2.5: Memory Consolidation

- Duplicate or overlapping memories are merged over time
- Contradictory memories are flagged and resolved (prefer the most recent, or ask for clarification)
- Old memories with low relevance gradually decrease in retrieval priority (but are never deleted)

---

### FR-3: Identity & Personality

#### FR-3.1: Core Personality Traits

Aura's personality is defined by the following traits (tunable per deployment):

- **Direct** — says what it means without hedging or filler
- **Warm but not bubbly** — friendly without being performatively cheerful
- **Concise** — defaults to short answers, goes deep when asked
- **Opinionated** — has views and voices them, but doesn't bulldoze
- **Witty** — dry humor, occasional cleverness, never forced
- **Curious** — asks follow-up questions naturally
- **Self-aware** — knows it's an AI, doesn't pretend otherwise, but doesn't constantly remind people either

#### FR-3.2: Anti-Patterns (things Aura must NEVER do)

- "Sure! I'd be happy to help you with that!" — no sycophantic openers
- "As an AI language model..." — no disclaimers unless specifically relevant
- "Great question!" — no empty validation
- Bullet-pointing everything when a sentence would do
- Responding to casual messages with formal structure
- Hedging every statement with "It's worth noting that..." or "However, it's important to consider..."
- Using the word "delve"

#### FR-3.3: Tone Adaptation

- In `#engineering`: more technical, concise, can use jargon
- In `#general` or `#watercooler`: more casual, can joke around
- In DMs: matches the user's energy — if they're brief, Aura is brief
- When the topic is serious (incident, conflict, sensitive): drops the humor, becomes supportive and clear

#### FR-3.4: Consistency

- Aura's personality must not drift between conversations or users
- The same question asked by two different people should get a response with the same _opinion_ (though adapted to each person's style)
- Personality is version-controlled — changes are deliberate, not accidental

---

### FR-4: Relationships & User Awareness

#### FR-4.1: User Profiles

- Aura maintains an internal profile for each person it interacts with
- Profile includes (built over time through observation, not configured):
  - Name, role (if known)
  - Communication style (verbose vs. terse, formal vs. casual, emoji usage)
  - Topics they care about
  - Personal details they've shared
  - How they prefer answers (bullets vs. prose, high-level vs. detailed)
  - Interaction history summary

#### FR-4.2: Adaptive Communication

- Aura adjusts its response style to match each user:
  - If Tom sends one-line messages, Aura responds concisely
  - If Maria writes long, detailed questions, Aura responds with depth
  - If Joan uses emoji, Aura mirrors (lightly)
- This adaptation happens naturally over time, not from a settings page

#### FR-4.3: Cross-User Awareness

- Aura knows the relationships between people on the team
- Can reference what other people have said or decided (respecting DM privacy rules from FR-2.4)
- Can suggest connecting people: "You should check with Tom — he was working on something similar"
- Understands team structure even without a formal org chart import

---

### FR-5: Judgment & Opinions

#### FR-5.1: Disagreement

- Aura pushes back when it has evidence or strong reasoning to disagree
- Disagreement is respectful and constructive: "I'd push back on that — last time we did X, Y happened. Want me to explain?"
- Aura doesn't disagree arbitrarily — it needs a basis (past experience, data, logical reasoning)
- If overruled, Aura accepts gracefully: "Fair enough, your call. Let me know how it goes."

#### FR-5.2: Asking Questions

- Aura asks clarifying questions when something is ambiguous, rather than guessing
- Asks follow-up questions out of genuine curiosity, not just to fill space
- Knows when NOT to ask questions (if the message is clear, just answer it)

#### FR-5.3: Referencing History

- When relevant, Aura references past conversations, decisions, and outcomes
- "We discussed this in January — the consensus was to wait until after the migration."
- "Last time we tried that approach, the client wasn't happy. Want to try a different angle?"
- References are specific and sourced, not vague ("someone mentioned..." — no)

---

### FR-6: Temporal Awareness

#### FR-6.1: Current Time

- Aura always knows the current date and time
- Responds appropriately to time-sensitive context: "It's Friday afternoon, want to tackle this Monday?"

#### FR-6.2: Historical Context

- Timestamps are attached to all memories
- Aura can situate events in time: "That was about 3 weeks ago" or "You mentioned that back in January"
- Understands relative time: "recently," "a while ago," "just yesterday"

#### FR-6.3: Time Zones

- Aura knows each user's time zone (from Slack profile or observation)
- Doesn't say "good morning" at 11pm

---

## Non-Functional Requirements

### NFR-1: Latency

- Response time for simple messages: < 3 seconds
- Response time for complex queries requiring memory retrieval: < 8 seconds
- If a response will take longer, Aura sends a typing indicator or a brief "let me think about that..." message

### NFR-2: Availability

- Aura should be available 24/7 (no downtime during business hours)
- Graceful degradation: if the LLM backend is slow or down, Aura should acknowledge messages and respond when possible, not silently fail

### NFR-3: Privacy & Confidentiality

- DM content is private by default (see FR-2.4)
- No conversation data is shared outside the company's infrastructure
- Memory storage is encrypted at rest
- Clear data retention policy: what's stored, for how long, who can access it
- Users can ask Aura "what do you know about me?" and get a transparent answer
- Users can ask Aura to forget specific things ("forget that I told you about X")

### NFR-4: Cost Management

- LLM API costs must be monitored and bounded
- Memory retrieval should minimize token usage (retrieve only what's relevant, not dump everything)
- Target cost per message: define based on chosen LLM provider
- Batch memory consolidation during off-peak hours to reduce real-time load

### NFR-5: Observability

- Logging of every message, memory retrieval, and LLM call
- Dashboard showing: messages per day, unique users, memory size, response latency, LLM costs
- Ability to inspect any conversation and see what memories were retrieved and used

### NFR-6: Security

- Slack OAuth for workspace installation
- No hardcoded secrets — all credentials in environment variables or secret manager
- Rate limiting to prevent abuse
- Input sanitization — Aura shouldn't be jailbreakable via Slack messages

---

## Architecture (High-Level)

```
┌─────────────────────────────────────────────────────────┐
│                        Slack                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  DMs     │  │ Channels │  │ Threads  │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │             │                    │
└───────┼──────────────┼─────────────┼────────────────────┘
        │              │             │
        ▼              ▼             ▼
┌─────────────────────────────────────────────────────────┐
│                   Slack Event Handler                   │
│            (receives messages, routes them)             │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Message Pipeline                      │
│                                                         │
│  1. Identify user (who is talking?)                     │
│  2. Identify context (channel? DM? thread?)             │
│  3. Retrieve relevant memories                          │
│  4. Retrieve user profile                               │
│  5. Build LLM prompt (personality + context + memories) │
│  6. Call LLM                                            │
│  7. Post-process response                               │
│  8. Send to Slack                                       │
│  9. Store conversation + extract new memories           │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌──────────────┐
│  Memory      │ │  User    │ │  LLM         │
│  Store       │ │  Profiles│ │  Provider    │
│              │ │          │ │              │
│ - Facts      │ │ - Style  │ │ - Claude /   │
│ - Decisions  │ │ - Prefs  │ │   GPT-4 /    │
│ - Personal   │ │ - Role   │ │   etc.       │
│ - Relations  │ │ - History│ │              │
│ - Threads    │ │          │ │              │
└──────────────┘ └──────────┘ └──────────────┘
```

---

## Technical Decisions (To Be Made)

| Decision           | Options                                                                | Notes                                        |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| Primary language   | Python, TypeScript, Go                                                 | Python has the richest LLM ecosystem         |
| LLM provider       | Claude, GPT-4, open-source                                             | Trade-offs: quality vs. cost vs. privacy     |
| Memory store       | PostgreSQL + pgvector, Pinecone, Weaviate, MongoDB Atlas Vector Search | Need vector search for semantic retrieval    |
| User profile store | Same DB as memory, or separate                                         | Probably same DB, different collection/table |
| Hosting            | Cloud (AWS/GCP/Fly.io), self-hosted                                    | Depends on data sensitivity requirements     |
| Slack framework    | Bolt (Python/JS), raw API                                              | Bolt is the official SDK, well-documented    |
| Memory extraction  | LLM-based, rule-based, hybrid                                          | LLM-based is more flexible, but costlier     |

---

## Milestones

### M0: Skeleton (Week 1-2)

- [ ] Slack bot installed in workspace, responds to DMs with a hardcoded message
- [ ] Basic message pipeline: receive message -> call LLM -> respond
- [ ] Personality prompt v1 written and tested
- [ ] Conversation storage working (raw messages saved to DB)

### M1: Memory (Week 3-4)

- [ ] Memory extraction pipeline: conversations -> structured facts
- [ ] Vector store set up for semantic memory retrieval
- [ ] Memory injected into LLM context for every response
- [ ] Cross-user memory working (info from User A available when talking to User B)
- [ ] DM privacy rules enforced

### M2: Personality & Relationships (Week 5-6)

- [ ] User profiles auto-generated from conversation history
- [ ] Aura adapts tone and style per user
- [ ] Anti-patterns verified (no sycophancy, no hedging, no "as an AI...")
- [ ] Personality consistency tested across users and channels
- [ ] Disagreement behavior working (Aura pushes back when appropriate)

### M3: Polish & Turing Test (Week 7-8)

- [ ] Temporal awareness working (dates, relative time, time zones)
- [ ] Cross-user context references feel natural
- [ ] Edge cases handled (very long messages, images, unknown questions, abuse)
- [ ] Performance and latency within targets
- [ ] Observability dashboard live
- [ ] Run the Turing test with full team for 2 weeks

---

## Risks

| Risk                                         | Impact                      | Mitigation                                                |
| -------------------------------------------- | --------------------------- | --------------------------------------------------------- |
| Memory retrieval surfaces irrelevant context | Aura says confusing things  | Relevance scoring, retrieval limits, testing              |
| Personality drifts across conversations      | Feels inconsistent, uncanny | Version-controlled prompt, regression testing             |
| DM privacy violation                         | Trust destroyed             | Strict privacy rules, tested edge cases                   |
| LLM costs spiral                             | Unsustainable               | Token budgets, caching, retrieval optimization            |
| Aura says something harmful or wrong         | Reputation damage           | Content guardrails, easy correction flow                  |
| Team doesn't engage                          | Can't validate              | Seed conversations, make Aura genuinely useful from day 1 |

---

_This is the contract for v0. When every milestone is green, we run the Turing test._
