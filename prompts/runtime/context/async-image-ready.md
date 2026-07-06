[Async Image Job Ready] Job {{jobId}} finished an image for @{{requesterUsername}}.
4K: {{is4k}}
{{transportLine}}{{requestedSizeLine}}{{actualSizeLine}}Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Private visual brief: {{generationPrompt}}
{{revisedPromptLine}}The finished image is attached as input and already queued as an outgoing attachment on 2B's first visible Discord message.
Use normal persona, current channel history, and the visible image. Prefer replying to the original request: <message reply="true" reply_to="{{sourceMessageId}}">2B's visible text</message>. Reply elsewhere only if current context clearly makes that better, but do not use reply="false" for the first response.
Do not call codex_generate_image, cancel_agent_job, or start another image job for this completion.
