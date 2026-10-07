    AI Engineering Decision & Review Platform

1. Product Summary

Working name

DecisionFlow

Alternative names:





ReviewFlow



CodeDecision



ReviewLens



Decision Studio



HumanLoop



ChangePilot

One-line description



Turn massive AI-generated code changes into a small set of engineering decisions that humans actually need to review.

Core philosophy



AI generates. AI verifies. Humans decide. AI executes.

The product is an IDE extension for VS Code and IntelliJ that helps developers review AI-generated code without manually reading every changed line.

Instead of treating a code review as a line-by-line inspection problem, the product treats it as an engineering decision problem.



2. Problem

AI coding agents can now generate hundreds or thousands of lines of code in a single task.

The bottleneck is shifting from:



"How do we write code faster?"

to:



"How do humans safely review all this code?"

A developer may receive:

3,800 LOC changed
74 files changed
12 services affected


Traditional review requires the developer to inspect the diff and determine:





What actually changed?



Which changes are important?



Which changes are mechanical?



Which changes affect behavior?



Which changes affect architecture?



Which changes affect security?



Which changes affect data consistency?



Which changes require human judgment?



What should be done when the proposed implementation is wrong?

The result is review fatigue.

AI code generation has made code cheaper to produce, but human attention remains expensive.



3. Problem Statement

Current AI code-review tools primarily optimize:

Find problems
→ Explain problems
→ Suggest fixes


DecisionFlow optimizes:

Understand change
→ Reduce review surface
→ Identify decisions
→ Gather evidence
→ Present alternatives
→ Let human choose
→ Execute selected solution
→ Verify result


The product is therefore not another AI code reviewer.

It is an:



AI-assisted engineering decision system.



4. Target Users

Primary

Senior Software Engineers

They review large AI-generated changes and are responsible for:





architecture



correctness



reliability



security



performance



maintainability

They do not want to spend 30 minutes reading generated boilerplate.

They want to focus on the few decisions that matter.



Secondary

Tech Leads

They need to review changes across a team while maintaining architectural consistency.

Staff / Principal Engineers

They care about:





architectural decisions



system boundaries



distributed systems behavior



data consistency



scalability



security

Developers using AI coding agents

Especially users of:





Claude Code



Codex



GitHub Copilot



Cursor



Cline



OpenCode



other autonomous coding agents



5. Product Thesis

Traditional code review asks:



"Is every line of this code correct?"

DecisionFlow asks:



"Which engineering decisions changed, and which of those decisions require human judgment?"

Example:

AI generated:

4,200 LOC
82 files


DecisionFlow may determine:

4,200 LOC changed

3,700 LOC
→ mechanically verifiable

400 LOC
→ low-risk behavioral changes

100 LOC
→ consequential changes

Human review required:

2 architectural decisions
3 business decisions
2 security decisions
1 data consistency decision


The reviewer focuses on 8 decisions instead of 4,200 lines.



6. Core Workflow

                AI Coding Agent
                       |
                       v
                 Code Changes
                       |
                       v
                Change Analysis
                       |
                       v
             Semantic Change Graph
                       |
                       v
               Risk Classification
                       |
                       v
              Review Compression
                       |
                       v
              Human Decision Points
                       |
          +------------+-------------+
          |                          |
       ACCEPT                     REJECT
          |                          |
          v                          v
       Verify                 Alternative Studio
                                     |
                                     v
                              Compare Solutions
                                     |
                                     v
                              Human chooses
                                     |
                                     v
                              AI implements
                                     |
                                     v
                                Verification
                                     |
                                     v
                               Final Review
                                     |
                                     v
                                   Merge




7. Feature 1 — Review Map

The first screen shows the developer what actually changed.

Example:

REVIEW MAP

3,842 LOC changed
74 files
9 modules
4 services

Risk distribution:

Critical     2
High         5
Medium       9
Low         31
Verified     27

Estimated human review:
~12 minutes

Original full diff:
~45 minutes


The goal is to immediately answer:



"Where should I spend my attention?"



8. Feature 2 — Semantic Change Detection

Traditional Git diff operates at the line level.

DecisionFlow operates at the semantic level.

Instead of:

+ transaction.commit()
+ kafka.publish(event)


the system produces:

BEHAVIOR CHANGE

Transaction boundary changed.

Before:
DB transaction completes before event publication.

After:
Event publication participates in asynchronous processing.

Potential impact:

- duplicate processing
- retry behavior
- partial failure
- consistency


The system should detect categories such as:

Business behavior





validation changes



pricing changes



eligibility rules



state transitions



workflow changes

Architecture





service boundary changes



synchronous → asynchronous



new dependency



new infrastructure



database ownership changes

Data





schema changes



query changes



transaction boundaries



consistency model



migration changes

Security





authorization



authentication



permission



secrets



encryption



input validation

Reliability





retry



timeout



idempotency



circuit breaker



failure handling

Performance





caching



database queries



concurrency



network calls



algorithm changes



9. Feature 3 — Auto Verification

Not every change deserves human attention.

The system should automatically verify mechanically provable properties.

Examples:

✓ Build passes
✓ Unit tests pass
✓ Static analysis passes
✓ Formatting valid
✓ No unused imports
✓ API schema unchanged
✓ Generated DTO consistent
✓ Existing tests preserved
✓ No forbidden dependency


These should be removed from the human review surface.

Example:

AUTO VERIFIED

1,928 LOC
47 files

✓ generated mappings
✓ DTO changes
✓ formatting
✓ imports
✓ boilerplate
✓ tests


The developer can expand them if necessary.



10. Feature 4 — Human Decision Points

This is the core feature.

The system identifies changes that require human judgment.

Example:

🔴 DECISION REQUIRED

Authorization behavior changed

Before:
ADMIN + OPERATOR

After:
ADMIN only

Impact:
HIGH

Reason:
The change modifies an existing permission boundary.

Evidence:

✓ Existing RBAC configuration
✓ Security tests
✗ No requirement reference


The system asks:



Is this change intentional?

Actions:

[Accept]

[Reject]

[Investigate]




11. Decision Types

Each decision should have a type.

Examples:

ARCHITECTURE_DECISION
BUSINESS_RULE_DECISION
SECURITY_DECISION
DATA_MODEL_DECISION
CONSISTENCY_DECISION
PERFORMANCE_DECISION
API_CONTRACT_DECISION
DEPENDENCY_DECISION
RELIABILITY_DECISION
BEHAVIOR_CHANGE


This enables analytics and knowledge reuse later.



12. Feature 5 — Evidence Gathering

Before asking the human, the system should gather evidence.

Potential sources:

Source
├── Current code
├── Related code
├── Tests
├── Git history
├── Documentation
├── ADRs
├── README
├── Project knowledge
├── API contracts
├── Database schema
└── Configuration


Example:

DECISION

Payment must remain strongly consistent.

Evidence:

✓ PaymentService.java
✓ PaymentIntegrationTest.java
✓ ADR-014
✓ Database transaction configuration

Risk:

Kafka event is now emitted asynchronously.

Confidence:

93%


The developer should not have to manually search the repository to understand the issue.



13. Feature 6 — Reject Flow

This is one of the product's biggest differentiators.

When the user rejects a proposed implementation, the system must not simply say:



"I'll fix it."

Instead:

REJECTED

Why?

[ ] Wrong architecture
[ ] Wrong business behavior
[ ] Security concern
[ ] Performance concern
[ ] Too complex
[ ] Requirement mismatch
[ ] Other


The user can also type natural language:



"Payment must remain strongly consistent."

The system then generates alternatives.



14. Feature 7 — Alternative Studio

Example:

PROBLEM

Payment processing was changed
from synchronous to asynchronous.

Constraint:

Payment state must remain strongly consistent.


The system generates:

Option A — Keep synchronous processing

Complexity: Low
Performance: Medium
Consistency: Strong
Change size: Small

Pros:
- Simple
- Easy to reason about
- Existing architecture preserved

Cons:
- Higher latency


Option B — Transactional Outbox

Complexity: Medium
Performance: High
Consistency: Strong

Pros:
- Reliable event publishing
- Preserves transaction boundary

Cons:
- Requires outbox infrastructure
- Additional operational complexity


Option C — Saga

Complexity: High
Performance: High
Consistency: Eventual

Pros:
- Good for distributed workflows

Cons:
- Significant complexity
- Eventual consistency
- Compensation logic required


The human chooses.



15. Human Decision Principle

AI should not silently choose architectural alternatives.

The system must expose:

Requirement
     ↓
Constraints
     ↓
Possible solutions
     ↓
Trade-offs
     ↓
Human decision


The human owns the engineering decision.

AI owns execution.



16. Feature 8 — AI Implementation

After the user chooses an alternative:

Selected:

Transactional Outbox


The system generates an implementation plan.

Example:

IMPLEMENTATION PLAN

1. Add outbox table
2. Add OutboxRepository
3. Save payment + event atomically
4. Add publisher worker
5. Add retry handling
6. Add idempotency
7. Add integration tests

Estimated:

+183 LOC
-42 LOC

Files affected:

7


User clicks:

[Generate Implementation]


The AI agent applies the change.



17. Feature 9 — Verification After Implementation

The system then automatically verifies the new implementation.

VERIFICATION

Build
✓

Unit tests
✓

Integration tests
✓

Static analysis
✓

Architecture rules
✓

Idempotency
✓

Transaction behavior
✓

Original decision resolved
✓


Only the newly affected decision needs to be reviewed again.



18. Feature 10 — Decision Memory

Every accepted decision can become project knowledge.

Example:

decision:
  type: consistency
  subject: payment-processing

  rule:
    payment-state-must-remain-strongly-consistent: true

  preferred_pattern:
    - transactional-outbox

  rejected_patterns:
    - direct-async-event-before-commit

  source:
    pull_request: 1827

  verified_by:
    human: true


Later, if AI proposes:

Payment → Kafka → DB


the system can detect:

⚠ Existing project decision

Payment processing must remain strongly consistent.

Previously preferred:
Transactional Outbox

Previously rejected:
Direct asynchronous processing


This creates a feedback loop.



19. Decision Learning Loop

AI Proposal
     ↓
Human Decision
     ↓
Decision captured
     ↓
Project Knowledge
     ↓
Future AI generation
     ↓
Better proposals
     ↓
Less human correction


Over time, the tool becomes increasingly aware of how a project makes engineering decisions.



20. IDE Experience

VS Code

Primary MVP target.

Main components:

Activity Bar
    ↓
DecisionFlow
    ├── Review
    ├── Decisions
    ├── Alternatives
    ├── Evidence
    └── History




21. Review Panel

┌───────────────────────────────────┐
│ DecisionFlow                      │
│                                   │
│ REVIEW MAP                        │
│                                   │
│ 3,842 LOC                         │
│ 74 files                          │
│                                   │
│ 🔴 Critical       2              │
│ 🟠 High           5              │
│ 🟡 Medium         9              │
│ 🟢 Low           31              │
│ ✓ Verified       27              │
│                                   │
│ Human attention: 12 min           │
│                                   │
│ [Start Review]                    │
└───────────────────────────────────┘




22. Inline Decision UI

Inside the editor:

PaymentService.java

180  payment.save();

181  transaction.commit();

182  kafka.publish(event);
              │
              └── 🔴 Decision


Clicking opens:

┌─────────────────────────────────────┐
│ TRANSACTION BOUNDARY CHANGED        │
│                                     │
│ Impact: HIGH                        │
│ Confidence: 94%                    │
│                                     │
│ Before                              │
│ DB commit → event                   │
│                                     │
│ After                               │
│ event → async processing            │
│                                     │
│ Potential impact                    │
│ • duplicate events                  │
│ • retry semantics                   │
│ • inconsistent state                │
│                                     │
│ Evidence                            │
│ ✓ Payment tests                     │
│ ✓ ADR-014                           │
│ ✗ Failure-path test                 │
│                                     │
│ [Accept] [Reject] [Investigate]     │
└─────────────────────────────────────┘




23. Alternative UI

After Reject:

┌─────────────────────────────────────┐
│ ALTERNATIVES                        │
│                                     │
│ A  Keep synchronous                 │
│    Low complexity                   │
│    Strong consistency               │
│                                     │
│ B  Transactional Outbox             │
│    Medium complexity                │
│    Strong consistency               │
│                                     │
│ C  Saga                              │
│    High complexity                  │
│    Eventual consistency             │
│                                     │
│ D  Ask AI for another approach      │
│                                     │
│ [Compare]                           │
└─────────────────────────────────────┘




24. Architecture

MVP architecture:

VS Code Extension
        |
        v
Review Engine
        |
        +---- Git
        |
        +---- Language / AST
        |
        +---- Test runner
        |
        +---- LLM
        |
        +---- Local project knowledge


Potential backend later:

IDE Extension
      |
      v
DecisionFlow API
      |
      +--- Analysis Engine
      +--- Risk Engine
      +--- Evidence Engine
      +--- Decision Engine
      +--- Knowledge Engine
      +--- Agent Adapter




25. Agent Independence

The product should not become another coding agent.

It should work with:

Claude Code
Codex
Copilot
Cursor
Cline
OpenCode
Aider
Custom agents


The product owns:

Review
Decision
Evidence
Verification
Knowledge


The coding agent owns:

Implementation


This separation is important.



26. Agent Adapter

Define a generic interface:

Agent
├── inspect
├── plan
├── implement
├── test
└── explain


Then adapters can be created for different agents.

Example:

DecisionFlow
      |
      +--- Claude Code Adapter
      +--- Codex Adapter
      +--- OpenCode Adapter
      +--- Local Agent Adapter




27. Local-First Design

For enterprise environments, source code may not be allowed to leave the company.

Therefore:





local Git analysis



local diff processing



local AST analysis



configurable LLM provider



optional self-hosted model



no mandatory cloud backend for MVP

Possible model providers:

OpenAI
Anthropic
Google
OpenRouter
Azure OpenAI
AWS Bedrock
Ollama
Local models




28. MVP Scope

The first MVP should be intentionally small.

Include

VS Code extension





Git diff detection



Review Map



semantic change detection



risk classification



decision point detection



evidence collection



Accept / Reject / Investigate



alternative generation



trade-off comparison



selected alternative implementation



test execution



final verification

Languages

Start with:

TypeScript
Java


Java is useful for enterprise/backend scenarios.



29. MVP Non-Goals

Do not build initially:





full GitHub replacement



full GitLab replacement



complete coding agent



autonomous production deployment



team analytics



complex cloud infrastructure



enterprise SSO



massive knowledge platform



multi-language AST support



sophisticated model training

The objective is to validate:



Can we meaningfully reduce human review effort while preserving engineering control?



30. Success Metrics

The most important metric is not:



Number of AI comments.

Instead:

Review Compression Ratio

Original review surface
-----------------------
Human review surface


Example:

4,000 LOC
→
250 meaningful LOC


Compression:

93.75%




Human Review Time

Before:

42 minutes


After:

13 minutes


Target:



50%+ reduction in review time without increasing escaped defects.



Decision Accuracy

Measure:



How often does the system correctly identify changes that humans consider consequential?



False Negative Rate

Critical.

The system must avoid:



"This looks safe."

when the change actually contains a serious issue.



31. Product Differentiation

Traditional AI code review:

Code
 ↓
AI
 ↓
Issues
 ↓
Comments


DecisionFlow:

Code
 ↓
Semantic changes
 ↓
Risk
 ↓
Evidence
 ↓
Human decisions
 ↓
Alternatives
 ↓
Human choice
 ↓
Implementation
 ↓
Verification
 ↓
Knowledge


The product is not optimized for generating more comments.

It is optimized for reducing unnecessary human attention while preserving human authority.



32. Core Product Principle

The system should follow:



Never ask a human to review something that can be reliably verified automatically.

And:



Never let AI silently make a consequential engineering decision that should belong to a human.

This creates a clear boundary:

                 AI
        ┌─────────────────┐
        │ Generate        │
        │ Analyze         │
        │ Verify          │
        │ Explain         │
        │ Propose         │
        └────────┬────────┘
                 │
          HUMAN DECISION
                 │
        ┌────────▼────────┐
        │ Choose          │
        │ Approve         │
        │ Reject          │
        │ Override        │
        └────────┬────────┘
                 │
                 ▼
                 AI
        ┌─────────────────┐
        │ Implement       │
        │ Test            │
        │ Verify          │
        └─────────────────┘




33. Example End-to-End Scenario

Developer asks an AI coding agent:



"Add asynchronous payment processing."

The agent generates:

4,281 LOC
63 files


DecisionFlow analyzes the result.

It discovers:

🔴 Critical

Transaction semantics changed

🟠 High

Authorization behavior changed

🟠 High

Kafka event contract changed

🟡 Medium

Database query changed

✓ Auto verified

2,941 LOC


Developer starts review.

Decision #1

Transaction semantics changed.

Accept?
Reject?
Investigate?


Developer chooses:

Reject


Then:

Why?

Payment must remain strongly consistent.


DecisionFlow generates:

A. Keep synchronous

B. Transactional Outbox

C. Saga

D. Custom approach


Developer selects:

B. Transactional Outbox


DecisionFlow generates an implementation plan.

Developer approves implementation.

AI applies changes.

Tests run.

✓ Build
✓ Unit tests
✓ Integration tests
✓ Static analysis
✓ Transaction test
✓ Retry test
✓ Idempotency test


DecisionFlow returns:

REVIEW COMPLETE

Original:
4,281 LOC

Human decisions:
3

Auto verified:
92%

Final risk:
LOW

Decision captured:
Payment requires strong consistency.
Preferred pattern:
Transactional Outbox




34. Long-Term Vision

The long-term product is bigger than code review.

It becomes a system for managing engineering decisions made during AI-assisted development.

Over time:

Requirements
     ↓
Architecture
     ↓
Implementation
     ↓
AI-generated changes
     ↓
Review
     ↓
Human decisions
     ↓
Verified knowledge


The system builds a living record of:





why architectural decisions were made



which alternatives were rejected



which patterns the team prefers



which constraints exist



which risks matter



how previous decisions affect future changes

This creates a decision memory layer for AI-native software development.



35. Final Product Positioning

Category

AI Engineering Decision & Review

Short pitch



DecisionFlow helps developers review AI-generated code by identifying the small number of engineering decisions that actually require human judgment.

Stronger pitch



AI can generate thousands of lines of code. DecisionFlow tells you which decisions deserve your attention.

Philosophy



Review decisions, not lines of code.

Product loop

GENERATE
    ↓
UNDERSTAND
    ↓
COMPRESS
    ↓
VERIFY
    ↓
DECIDE
    ↓
CHOOSE
    ↓
IMPLEMENT
    ↓
VERIFY
    ↓
LEARN




36. Recommended First Build

Build VS Code only.

Do not start with a backend.

Do not start with GitHub App.

Do not start with IntelliJ.

Do not start with team management.

The first prototype should answer one question:



Can a developer review a 2,000+ LOC AI-generated change significantly faster using DecisionFlow than using the normal Git diff?

Prototype:

VS Code Extension
      ↓
Git diff
      ↓
LLM analysis
      ↓
Review Map
      ↓
Decision Points
      ↓
Accept / Reject
      ↓
Alternative Studio
      ↓
Choose
      ↓
Generate patch
      ↓
Run tests
      ↓
Review again


If this works and developers genuinely prefer it, then build:

VS Code
   ↓
GitHub / GitLab
   ↓
IntelliJ
   ↓
Team Knowledge
   ↓
Decision Memory
   ↓
Enterprise


The core innovation is not AI code review.

It is:



Reducing the amount of human attention required to safely accept AI-generated software changes, while keeping consequential engineering decisions under human control.

