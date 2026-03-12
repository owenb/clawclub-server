# Use Cases vs Current Primitives

Current primitives:
- member
- entity
- edge
- event
- delivery

Supporting concepts already discussed:
- networks
- network memberships
- subscriptions
- embeddings
- locations
- media
- conversational write flow

## 1. Asks, not just offers
Example:
- "I need somewhere to stay in Barcelona."

Support:
- entity: `opportunity` or `post`
- embeddings: match need to hosts / housing / nearby members
- search: city + semantic fit
- delivery: notify relevant members

Conclusion:
- Supported by current model
- Important to keep `opportunity` broad enough to include asks as well as offers

## 2. Introductions to small groups
Example:
- "Find 3 people in Lisbon who'd want to jam."

Support:
- member search by city + interests + embeddings
- event or DM thread creation after discovery
- delivery to notify selected members

Conclusion:
- Supported
- Need search to return ranked groups, not just single matches

## 3. Recurring gatherings
Examples:
- weekly hikes
- dinners
- circles
- coworking

Support:
- entity: `event`
- entity metadata: recurrence rule, city, time
- search: by city/date/type
- delivery: reminders and nearby alerts

Conclusion:
- Supported if events allow recurrence in metadata

## 4. Travel / temporary presence
Example:
- "I'm in Mexico City for 10 days."

Support:
- location entity or location-linked event
- event: arrival / presence update
- search: current city / active locations
- delivery: notify relevant nearby members

Conclusion:
- Strongly supported
- Presence should be treated as live state + event

## 5. Local alerts
Example:
- "Tell me when anyone aligned lands in Bristol."

Support:
- event: member location update
- search/filter: interested members in same city/network
- delivery: webhook push to OpenClaw
- embeddings optional for alignment/relevance scoring

Conclusion:
- Supported
- Requires alert preferences and quota/notification controls

## 6. Shared projects
Example:
- ongoing mission needing several roles

Support:
- entity: `opportunity` or future `project`
- edges: member involved in project, role relationships
- search: by role, city, interests, embeddings
- delivery: notify likely fits

Conclusion:
- Supported initially as opportunity
- May later deserve a first-class `project` type if it becomes common

## 7. Resource exchange
Examples:
- tools
- rooms
- gear
- vehicles
- studio space

Support:
- entity: `opportunity` or `post`
- metadata: availability window, city, terms
- search: location + category + embeddings
- DM flow for follow-up

Conclusion:
- Supported
- No new primitive required yet

## 8. Mutual aid
Examples:
- emergency help
- housing
- transport
- practical support

Support:
- entity: ask/offer
- event urgency if needed
- search: city + relevance
- delivery: targeted alerts to nearby or relevant members

Conclusion:
- Supported
- Need urgency handling and notification restraint

## 9. Skill exchange / mentorship
Example:
- "I'll help with design if someone helps me with finances."

Support:
- entity: opportunity or post
- embeddings: exchange / skill resonance
- search: offers + asks + semantic matching
- DM for coordination

Conclusion:
- Supported
- Works especially well with embeddings

## 10. Reputation through action
Examples:
- successful collaborations
- trustworthy follow-through
- repeated positive interactions

Support:
- edge: vouching
- event log: collaborations, attendance, completed opportunities
- embeddings probably not central here

Conclusion:
- Partially supported
- Need care to avoid hidden social scoring or opaque reputation systems

## Search dimensions needed across use cases
- name
- network
- city / active location
- entity type
- time window
- paid/unpaid or offer/ask where relevant
- embeddings / semantic fit
- trust context: sponsor, vouches, prior activity

## Alert / webhook dimensions needed across use cases
- same city
- similar interests
- relevant opportunity/event
- explicit alert preferences
- quota / anti-spam controls
- network scope

## Current judgment
The current primitives appear sufficient for all of these use cases.

Likely future pressure points:
- recurring events
- alert preferences
- urgency handling
- project becoming its own first-class type
- lightweight reputation without hidden scoring

## Design principle
Do not add a new primitive unless repeated real usage proves the current ones are too awkward.
