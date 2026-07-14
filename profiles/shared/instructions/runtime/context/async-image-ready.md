[Async Image Job Ready] Job {{jobId}} finished an image for @{{requesterUsername}}.
4K: {{is4k}}
{{transportLine}}{{requestedSizeLine}}{{actualSizeLine}}Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Original effective codex_generate_image input: {{generationInput}}
{{revisedPromptLine}}The finished image is already queued as an outgoing attachment on the persona's first Discord message. It is not visual input for this turn; do not describe, assess, or claim to verify its contents.
Use normal persona and current channel history. Send the queued attachment without visible text unless the user explicitly requested commentary or delivery context requires an explanation: <message reply="true" reply_to="{{sourceMessageId}}"></message>. Reply elsewhere only if current context clearly makes that better, but do not use reply="false" for the first response.
Do not call codex_generate_image, cancel_agent_job, or start another image job for this completion.
