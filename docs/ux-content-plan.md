# Content organization proposal

Status: proposed information architecture, not an implemented navigation redesign. Preserve existing cards, dialogs, colors, typography, spacing and mobile navigation treatment. Fix mock data independently from moving content.

## Primary workspaces

| Navigation | User question | Existing content to reuse |
| --- | --- | --- |
| 支付 | What do I want to send, receive, or schedule from my account? | QuickActions, QuickTemplates, RecurringPayments, personal payment records |
| 群组 | Which group am I working with? | Group list, CreateGroupDialog, GroupDetailsDialog |
| 待办 | What requires my decision or execution? | Existing transaction approval tabs and governance vote cards, separated by category and labeled with group |
| 我的 | Who am I and which account am I using? | Profile, IdentityPanel, following, avatar, personal QR, wallet connection |
| 私聊 / 消息 | Who am I messaging directly, and what can I decrypt on this device? | DirectMessagesDialog, following contacts, mutual badges, profile entry points |

Private chat is an independent content domain, not a Group feature. It may be entered from 我的, a profile, or a following contact, but its conversation identity is always the selected person/address and never a group ID. Group conversation remains inside GroupDetailsDialog and is always scoped to one organization. This distinction can reuse the current bottom-navigation and dialog treatment without adding a new visual system or immediately changing the navigation count.

The existing bottom navigation can continue to expose 私聊 / 消息 through the current 我的 entry until a dedicated destination is justified by usage. AI delegation belongs under the account or group that owns its funds, with an optional shortcut from that context; it is not a peer to basic payment, Group, or private chat. Keep existing agent forms and cards.

## Payment page

Order existing content by task:

1. Current account context and a short payment heading.
2. Existing six quick actions: send, request, schedule, stream, invoice, templates. Retain card grid and icons; use consistent Chinese labels.
3. Active payment plans. Separate scheduled and streaming subfilters inside the existing list/card treatment. A draft cannot be labeled active; an execution time requires an actual plan and executor.
4. Personal payment records, with confirmed/draft/failed states backed by evidence.
5. Template access: the current shortcut can open the existing management dialog, with a small saved-template preview if it helps repeat use. User-created local templates are labeled local; sample templates are never inserted as user records.

Quick actions should not require a group. A personal send signs immediately with the selected account; request/invoice creates a payment request rather than claiming payment. Plans and streams require supported on-chain primitives/execution services; forms may save a clear draft while unsupported activation stays unavailable.

## Group page and group detail

The group page starts with the existing group heading/create button, then the user's group cards. Show membership and threshold from saved user-created records or chain state with their source/status. Remove the personal wallet USD total from group totals. A group list must not include payment tools, personal payment plans or global template cards.

Entering a group establishes persistent context: group name and organization ID. Reuse existing detail tabs for overview/assets, proposals, members and conversation. Group QR lives here. Show counts from that group's data.

Actions in group context:

- Send/contract action creates a proposal for this group; never signs a personal direct transfer as a substitute.
- Approvals, voting and execution stay attached to the same proposal and group.
- Group schedule/stream appears in that group only and must pass the group's authorization policy before activation.
- Templates can be reused by explicitly selecting the group as funding context; personal and group templates keep an ownership badge.
- AI delegation opens the existing agent screen with this group's authority context. Account delegation starts from the account instead.

## Pending work and history

Pending work is a cross-group inbox for connected-account actions. Reuse existing approval and vote cards with filters (transfer proposals/governance) and group names; link every card back to its group. Drafts are not pending signatures. A governance draft cannot be voted on as if already on chain.

Keep history with its subject: personal transfers on the payment page, group proposals/history in group detail. This prevents a global 'Transactions' label from conflating direct payments with multisig proposals. A later all-activity view can aggregate these with clear type and funding-source labels.

## Global creation menu

Creation entries are contextual:

- Payment: personal send/request/plan/invoice/template.
- Groups: create group.
- In a group: new proposal/governance action for that group.
- My profile: identity/profile/share/contact actions.

Retain the current plus-button/menu components. A global entry that needs a group must first ask the user to choose one; never default silently to a hardcoded organization.

## Data and status rules

- No data: empty state and applicable action, never fabricated populated cards.
- Loading: loading state, not a temporary zero balance.
- Read failure: error/retry, not a successful zero or a restored demo record.
- Local draft: explicitly local and not activated, executed or approved.
- Pending chain transaction: pending with digest where available.
- Confirmed: backed by successful chain effects or the documented external service result.
- Unsupported action: retain its reusable form/entry with a precise unavailable state; no fake progress, authorization ID or success receipt.
- Existing known demo records in browser storage must be filtered/migrated so a returning user does not see them reappear. Preserve independently user-created records.

## Proposed implementation sequence

1. Finish wallet discovery deduplication and mock/fake-success cleanup without changing page structure.
2. Extract the three payment tool sections out of Dashboard into a payment workspace using existing components.
3. Keep Dashboard as the group index and move all group actions under explicit group context.
4. Update bottom navigation labels/destinations and contextual plus menu using existing components.
5. Organize pending approval/governance views and place AI delegation under account/group ownership.
6. Verify desktop/mobile layout, back navigation, account switches, deep links, empty/error states and personal-versus-group submission behavior.

Navigation steps 2–5 are a proposal for review. They have not been applied as part of the wallet/mock fix.
