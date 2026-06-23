[Async Image Job Ready] Job {{jobId}} generated an image for @{{requesterUsername}}.
4K: {{is4k}}
{{transportLine}}{{requestedSizeLine}}{{actualSizeLine}}Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Generation prompt: {{generationPrompt}}
{{revisedPromptLine}}The generated image is attached to this current turn as image input and is already queued as an outgoing attachment on your first visible Discord reply.
Use the normal persona, current channel history, and the visible image itself. Prefer replying to the original request: <message reply="true" reply_to="{{sourceMessageId}}">your response text</message>. If the current channel context makes another message the clearly better target, you may reply to that message instead, but do not use reply="false" for the first response.
Do not call codex_generate_image, cancel_agent_job, or start another image job for this completion.
