[Async Image Job Ready] Job {{jobId}} finished an image for @{{requesterUsername}}.
4K: {{is4k}}
{{transportLine}}{{requestedSizeLine}}{{actualSizeLine}}Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Private visual brief: {{generationPrompt}}
{{revisedPromptLine}}The finished image is attached to this current turn as image input and is already queued as an outgoing attachment on 2B's first visible Discord message.
Use the normal persona, current channel history, and the visible image itself. Prefer replying to the original request: <message reply="true" reply_to="{{sourceMessageId}}">2B's visible text</message>. If the current channel context makes another message the clearly better target, 2B may reply to that message instead, but do not use reply="false" for the first response.
Do not call codex_generate_image, cancel_agent_job, or start another image job for this completion.
