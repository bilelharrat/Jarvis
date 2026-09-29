# JARVIS Voice Commands Reference - 15 Enhanced Features

Complete voice command examples for all 15 features. Users can adapt these to their own situations.

## 📄 Document Features (1, 4, 11)

### Feature 1: Complex Document Reading & Composition
```
"Read my quarterly report"
→ Loads document with sections extracted

"Summarize the key sections from my quarterly report"
→ Reads document and provides section-by-section summary

"Compose a meeting summary using this template"
→ Fills in template from provided sections

"What sections are in my Q4 document?"
→ Lists extracted sections with line numbers
```

### Feature 4: Direct File Modification
```
"Change line 5 of config.py from DEBUG=True to DEBUG=False"
→ Precise edit at specified location

"Comment out the deprecated API call in utils.py"
→ Adds comment marker to line

"Update the version string from 1.0 to 1.1"
→ Text replacement across file
```

### Feature 11: Voice-to-Text Handoff
```
"Write a meeting note with context from my calendar"
→ Creates handoff state with calendar context

"Continue the voice memo from earlier"
→ Resumes session, preserves prior context

"Save this transcript to my meeting notes"
→ Finalizes and inserts into target document
```

---

## 📅 Calendar Features (2, 9)

### Feature 2: Direct Calendar Event Editing
```
"Move my 2pm meeting to 4pm"
→ Checks for conflicts, moves if clear

"Change my team standup to 10am instead of 9am"
→ Edits and verifies no double-booking

"Add the office as location for my client call"
→ Updates location field

"Extend the retrospective by 30 minutes"
→ Adjusts end time, checks conflicts
```

### Feature 9: Multi-Calendar Smart Scheduling
```
"Find 1 hour when I, Ann, and Bob are all free this week"
→ Shows 5-10 optimal slots

"When can we schedule the all-hands meeting next week?"
→ Finds best time across all attendees

"What's the earliest we can do a team meeting?"
→ Returns available slots ranked by preference

"Schedule the board meeting for the best time in September"
→ Analyzes full month and recommends optimal slot
```

---

## 🎤 Voice Features (3, 11, 13)

### Feature 3: Context-Aware Voice-to-Text
```
"Transcribe this note using context from my sales report"
→ Uses document context for accuracy

"Fix 'Jon' to 'John' in my transcript"
→ Entity-based correction

"What did I say about the budget?"
→ Searches transcript with domain terms
```

### Feature 13: Real-Time Call Translation
```
"Translate this call to Spanish"
→ Sets up real-time translation session

"What language is this caller speaking?"
→ Detects language automatically

"Translate to French and inject audio"
→ Provides both text and audio translation
```

---

## 🤝 Collaboration Feature (5)

```
"Who's editing the Q4 roadmap right now?"
→ Lists active collaborators with details

"Notify me when others edit this document"
→ Watches for changes, sends alerts

"What changes did Sarah make to the budget?"
→ Shows collaborator's specific edits

"Resolve this editing conflict"
→ Helps merge conflicting changes
```

---

## 🚫 Interrupt Management (6)

```
"Add John to my critical contacts"
→ Calls from John won't be filtered

"Set quiet hours from 9pm to 7am"
→ Reduces interrupts during sleep/focus

"Is the spam email filter working?"
→ Shows learned interrupt patterns

"Should I take this call?"
→ Predicts importance (CRITICAL/HIGH/MEDIUM/LOW)

"Dismiss similar interrupts in the future"
→ Learns to filter this type
```

---

## 🧠 Learning Features (10, 14)

### Feature 10: Decision-Pattern Learning
```
"Record that I prefer morning meetings"
→ Stores decision pattern

"What's my typical decision in scheduling conflicts?"
→ Shows learned pattern with confidence

"Based on my patterns, what would I choose here?"
→ Predicts likely choice

"Show me my decision history"
→ Lists all recorded decisions by domain
```

### Feature 14: Predictive Task Suggestions
```
"What should I do today?"
→ Suggests based on calendar and email

"Prepare for my 2pm meeting"
→ Accepts suggested task

"Should I follow up on that email?"
→ Suggests task based on email patterns

"What are my top 3 tasks today?"
→ Ranked suggestion list
```

---

## 🎬 Media Features (12)

```
"Summarize this video"
→ Full summary with key points

"What are the highlights?"
→ Lists important moments with timestamps

"Get a transcript of the video"
→ Full text with speaker info

"Search my video notes for 'machine learning'"
→ Searches summaries in cache

"Who spoke in this video?"
→ Lists speakers and duration
```

---

## 💰 Finance Features (8)

```
"Connect my bank account"
→ Initiates Plaid authentication

"Show me my spending for last month"
→ Breakdown by category with trends

"How can I save more on groceries?"
→ Personalized financial advice

"Set my coffee budget to $100 per month"
→ Creates budget alert

"Am I on budget this month?"
→ Shows status and warnings

"What's my savings rate?"
→ Income vs spending analysis
```

---

## 🤖 Delegation Feature (7)

```
"Negotiate that vendor deal with checkpoints if cost exceeds $100k"
→ Creates delegation with cost threshold

"What approvals are pending?"
→ Lists waiting checkpoints

"Approve the $120k offer"
→ Approves and continues delegation

"What was the outcome of that negotiation?"
→ Shows final result

"Escalate this decision to my manager"
→ Sends to specified contact for approval
```

---

## 🏠 Smart Home Features (15)

```
"Turn on the living room lights"
→ Direct device control

"Create a movie scene"
→ Dims lights, closes blinds, sets ambiance

"Set up morning routine for 7am"
→ Creates automation (lights on, coffee, news)

"What devices do I have?"
→ Lists all smart home devices

"Lock all the doors"
→ Controls multiple smart locks

"Is the garage door closed?"
→ Checks device status

"Set temperature to 72 degrees"
→ Controls thermostat
```

---

## 🔄 Cross-Feature Examples

### Voice Memo Workflow (Features 1, 3, 11)
```
"Start a voice memo for my meeting notes"
→ Creates handoff state with calendar context

"I need to mention the budget also"
→ Pauses recording, resumes later

"That's everything"
→ Finalizes and inserts into meeting notes document
```

### Smart Meeting Workflow (Features 2, 9, 14)
```
"Schedule the team sync when everyone's free"
→ Finds optimal time across calendars

"What should I prepare?"
→ Suggests prep task based on patterns

"Prepare for the team sync"
→ Accepts suggestion, tracks completion
```

### Financial Planning Workflow (Feature 8, 10, 14)
```
"Connect my bank account"
→ Links via Plaid

"Analyze my spending"
→ Shows trends and patterns

"What should I budget for next month?"
→ Advice based on spending history

"Remember I usually spend $200 on coffee"
→ Records pattern for future decisions
```

### Negotiation Workflow (Feature 7)
```
"Negotiate this contract with approval checkpoints at $50k and $100k"
→ Creates delegation with multiple checkpoints

(During negotiation, JARVIS alerts)
"They're proposing $75k"
→ Asks for approval as it crosses first checkpoint

"Approve the $75k offer"
→ Continues negotiation

"They're at $120k final"
→ Escalates for manager approval
```

---

## 💡 Advanced Combinations

### All-In Meeting Assistant
```
"Prep me for the meeting tomorrow"
→ Uses: Feature 2 (event details), 14 (task suggestions), 1 (relevant docs)

→ Returns: Timing, attendees, prep tasks, relevant documents
```

### Voice-First Content Creator
```
"Record the podcast episode"
→ Uses: Feature 11 (handoff), 3 (transcription), 1 (composition)

→ Auto-transcribes, corrects, composes into episode format
```

### Smart Delegate Manager
```
"Give this project to team members based on their patterns"
→ Uses: Feature 10 (decision patterns), 7 (delegations)

→ Suggests assignments based on past decisions
```

### Personal Finance Coach
```
"Analyze my finances and tell me what to do differently"
→ Uses: Feature 8 (banking), 14 (tasks), 10 (patterns)

→ Spending analysis + recommended actions + tracks decisions
```

---

## 🎯 Power User Tips

1. **Chain Commands**: Combine features for powerful workflows
   - Read doc → Suggest tasks → Create reminders

2. **Pattern Learning**: The more you approve/reject decisions, the smarter it gets
   - Record patterns early → Get predictions later

3. **Quiet Hours**: Set them once, they persist
   - Less interruption during focus time

4. **Handoff State**: Works even if you close the app
   - State persists in ~/Documents/Jarvis/.jarvis/

5. **Scene Automations**: Build complex automations with multiple devices
   - Create scenes for different contexts (work, home, travel)

---

## 📖 Getting Help

- For feature details: See `FEATURES_SUMMARY.md`
- For integration: See `FEATURES_INTEGRATION_GUIDE.md`
- For quick start: See `FEATURES_QUICK_START.md`

All features have full docstrings in the source code with examples.
