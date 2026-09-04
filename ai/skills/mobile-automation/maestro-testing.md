# Mobile UI Testing & Automation with Maestro (Android & iOS)

This skill guides AI agents and engineers on utilizing **Maestro** (`mobile.dev`) as a unified, declarative UI automation framework (the mobile equivalent to Playwright) across Android emulators/devices and iOS simulators/devices.

---

## 1. What is Maestro & Cross-Platform Parity

**Maestro** is a modern, declarative mobile UI testing framework built for native, React Native, Flutter, and hybrid mobile applications.

### Key Capabilities:
* **True Multi-Platform Support**: Identical YAML syntax works across **Android** (via ADB / UIAutomator) and **iOS** (via Xcode `simctl` & Facebook `idb_companion`).
* **Built-in Resilience**: Automatically handles network latency, animation settling, and dynamic view rendering with built-in auto-retry mechanisms (eliminating arbitrary `sleep` timeouts).
* **Zero App Modification**: Does not require embedding test SDKs or compiling custom test runners into the production application package.
* **CLI & Agent Friendly**: Headless CLI execution makes it ideal for automated agent workflows, CI/CD pipelines, and local developer verification.

---

## 2. Installation & Environment Setup

### A. Installing the Maestro CLI
```bash
# Install Maestro binary (installs to ~/.maestro/bin)
curl -FsSL "https://get.maestro.mobile.dev" | bash

# Add to PATH
export PATH="$PATH:$HOME/.maestro/bin"
```

### B. Android Environment Prerequisites
* Android SDK tools (`adb`) installed and on `PATH`.
* Running emulator (`adb devices`) or connected physical device with USB debugging enabled.

### C. iOS Environment Prerequisites (macOS)
* Xcode Command Line Tools installed (`xcode-select --install`).
* Active iOS Simulator (`xcrun simctl list devices | grep Booted`) or Facebook `idb` for physical devices.

---

## 3. Anatomy of a Maestro Flow

Maestro flows are written in clean YAML. Each flow starts with an `appId` (Android package name or iOS Bundle ID) followed by a sequence of user commands.

### Core Command Reference

| Command | Syntax Example | Description |
| :--- | :--- | :--- |
| `launchApp` | `launchApp: { clearState: true }` | Launches target app (optionally resets app storage). |
| `tapOn` | `tapOn: "Log In"`<br/>`tapOn: { id: "com.app:id/submit_btn" }` | Taps element matching text, resource-id, or accessibility label. |
| `inputText` | `inputText: "user@example.com"`<br/>`inputText: { id: "field_id", text: "secret" }` | Types text into currently focused or targeted field. |
| `eraseText` | `eraseText: 10` | Backspaces specified number of characters. |
| `assertVisible` | `assertVisible: "Welcome back"` | Verifies an element is rendered and visible on screen. |
| `assertNotVisible` | `assertNotVisible: "Error"` | Verifies an element is absent or hidden. |
| `scroll` | `scroll` | Performs a vertical downward scroll. |
| `scrollUntilVisible` | `scrollUntilVisible: { element: "Terms & Conditions" }` | Continuously scrolls down until target element appears. |
| `swipe` | `swipe: { direction: "LEFT" }` | Swipes screen or carousel left, right, up, or down. |
| `back` | `back` | Simulates system Android Back button or iOS back gesture. |
| `takeScreenshot` | `takeScreenshot: "artifacts/screen1"` | Captures PNG screenshot to specified path. |
| `evalScript` | `evalScript: ${output.randomPhone = "+1" + Math.floor(Math.random()*1000000000)}` | Executes JavaScript inline for test data generation. |
| `runFlow` | `runFlow: "subflows/login.yaml"` | Executes nested re-usable sub-flow. |

---

## 4. Writing Selector Strategies & Relative Positioning

When elements lack distinct text or IDs, use hierarchical and directional selectors:

```yaml
# Tap text that is located below a specific header
- tapOn:
    text: "Select Country"
    below: "Destination"

# Tap button located to the right of an icon
- tapOn:
    id: "action_button"
    rightOf: "avatar_image"

# Regex matching
- assertVisible:
    text: "Total: \\$[0-9,]+\\.[0-9]{2}"
```

---

## 5. Practical Implementation Examples

### Example 1: Sendwave Android Verification Flow (`sw-android-login.yaml`)

```yaml
appId: com.mychime.waveremit.app.staging
---
# 1. Launch with clean storage state
- launchApp:
    clearState: true

# 2. Wait for Splash/Onboarding screen
- assertVisible: "Send money"

# 3. Handle OneTrust CMP Consent Dialog (if present)
- runFlow:
    when:
      visible: "Accept All"
    commands:
      - tapOn: "Accept All"

# 4. Initiate Login
- tapOn: "Log In"
- inputText:
    id: "com.mychime.waveremit.app.staging:id/phone_input"
    text: "+1555019283"
- tapOn: "Next"

# 5. Verify 2FA / Password entry screen rendered
- assertVisible: "Enter password"
- takeScreenshot: "artifacts/login_screen"
```

### Example 2: Cross-Platform Environment Branching (`transfer-flow.yaml`)

```yaml
appId: ${APP_ID} # e.g. com.mychime.waveremit.app.staging (Android) or com.sendwave.Sendwave (iOS)
---
- launchApp
- assertVisible: "Sendwave"

# Select Corridor
- tapOn: "Send to"
- inputText: "Kenya"
- tapOn: "Kenya (KES)"

# Enter Send Amount
- tapOn: { id: "send_amount_input" }
- inputText: "100"

# Verify Exchange Rate & Fee breakdown
- assertVisible: "No fee"
- assertVisible: "KES"

- tapOn: "Next"
- assertVisible: "Choose Recipient"
```

---

## 6. Agent Execution & Diagnostic Workflows

When testing via AI agent shell tooling:

### Step 1: Discover Connected Target
```bash
# Android
adb devices

# iOS Simulator
xcrun simctl list devices | grep Booted
```

### Step 2: Run Flow Headless & Generate Report
```bash
# Run flow and record test run
maestro test flows/sendwave_login.yaml --format junit --output report.xml
```

### Step 3: Correlate UI State with Logs & System Telemetry
Combine Maestro automation with concurrent log streams to catch analytics and attribution events:

```bash
# Android: Stream Meta & Consent logs during flow execution
adb logcat -v time | grep -iE "FacebookSDK|OTConsentChanges|AppEvents"
```

---

## 7. Best Practices & Anti-Patterns

1. **Avoid Arbitrary Sleep**: Use `assertVisible` or `scrollUntilVisible` instead of static wait intervals.
2. **Modularize Sub-Flows**: Keep authentication (`auth.yaml`) and onboarding in separate sub-flows invoked via `runFlow`.
3. **Parameterize App Identifiers**: Use `${APP_ID}` variables so the exact same test file can validate Dev, Staging, and Production variants across both OS platforms.
4. **Isolate Test Data**: Leverage `evalScript` to generate unique test phone numbers, emails, or recipient names to prevent idempotency conflicts.
