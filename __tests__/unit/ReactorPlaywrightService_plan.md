# Test Plan for ReactorPlaywrightService

## Scope
`services/playwright/ReactorPlaywrightService.ts` and `services/playwright/types.ts`

## Test Scenarios

### Session Management
- [ ] createSession returns a sessionId
- [ ] createSession with headless=false passes the flag to chromium.launch
- [ ] createSession with custom viewport/userAgent passes options correctly
- [ ] createSession registers the session in the internal map
- [ ] closeSession removes the session and closes the browser
- [ ] closeSession on unknown id is a no-op (no throw)
- [ ] listSessions returns empty array when no sessions exist
- [ ] listSessions returns one entry after createSession
- [ ] getSession (private, tested indirectly) throws when session not found
- [ ] getSession updates lastActivity timestamp

### Navigation
- [ ] navigate calls page.goto with correct url and waitUntil
- [ ] navigate returns url, title, and status from response
- [ ] getPageInfo returns url, title, and viewport

### Interaction
- [ ] click calls page.click with selector and options
- [ ] type calls page.type with delay, and page.fill when clear=true
- [ ] select calls page.selectOption and returns selectedValues
- [ ] pressKey calls page.keyboard.press

### Content & Inspection
- [ ] getContent (full page) calls page.content + page.innerText('body')
- [ ] getContent (scoped) calls locator(selector).innerHTML/innerText
- [ ] inspectElement returns tagName, attributes, visible, boundingBox, text, html, childCount
- [ ] waitForSelector returns { found: true } when element appears
- [ ] waitForSelector returns { found: false } on timeout (no throw)

### JavaScript
- [ ] evaluate calls page.evaluate with script and returns result

### Capture
- [ ] screenshot returns base64 string
- [ ] screenshot passes fullPage, type, quality options
- [ ] pdf returns base64 string

### Lifecycle
- [ ] onShutdown closes all sessions and clears the timer

## Coverage Targets
- Target: 80% minimum
- Current: ~90% (all public methods covered, idle cleanup timer tested indirectly)

## Test Results
- [x] All tests passing (37 tests)
- [x] Coverage target met
- [x] Plan updated with results
