# Test Plan for Voice Integration (Phase 3)

## Test Scenarios

### AIProviderBase - speech2Text
- [x] Scenario 1: speech2Text delegates to SpeechService.transcribe() and returns text
- [x] Scenario 2: speech2Text converts base64 string audio to Buffer before transcribing
- [x] Scenario 3: speech2Text converts Buffer[] audio to concatenated Buffer before transcribing
- [x] Scenario 4: speech2Text throws when SpeechService is not available

### AIProviderBase - chatAudio
- [x] Scenario 5: chatAudio transcribes audio then delegates to chat() with the text
- [x] Scenario 6: chatAudio throws when SpeechService is not available

### OpenAIService - speech2Text / chatAudio
- [x] Scenario 7: OpenAIService.speech2Text delegates to SpeechService
- [x] Scenario 8: OpenAIService.chatAudio transcribes then calls chat()

### ReactorChat Resolver - ReactorAskQuestionAudio
- [x] Scenario 9: ReactorAskQuestionAudio uses SpeechService for transcription
- [x] Scenario 10: ReactorAskQuestionAudio returns error on failure

### ReactorChat Resolver - Voice Session Mutations
- [x] Scenario 11: ReactorStartVoiceSession creates a voice session with stream URLs
- [x] Scenario 12: ReactorEndVoiceSession returns true
- [x] Scenario 13: ReactorSendVoiceMessage transcribes, sends, and optionally synthesizes

### Streaming Types
- [x] Scenario 14: StreamingSession voice field is optional and correctly typed

## Coverage Targets
- Target: 80% minimum for voice integration code
- Current: TBD

## Test Results
- [x] All tests passing (14/14)
- [x] Coverage target met
- [x] Plan updated with results
