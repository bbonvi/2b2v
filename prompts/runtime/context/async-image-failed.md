[Async Image Job Failed] Job {{jobId}} {{statusText}} for @{{requesterUsername}}.
Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Generation prompt: {{generationPrompt}}
Failure detail for context: {{failureDetail}}
The image was not generated and there is no outgoing image attachment.
Use the normal persona and current channel history. Prefer replying to the original request: <message reply="true" reply_to="{{sourceMessageId}}">your response text</message>. If the current channel context makes another message the clearly better target, you may reply to that message instead.
You may retry with codex_generate_image from this failure turn, but prefer not to unless the user asked for a retry or you are certain a revised prompt will work this time. If you retry, first tell the user the image failed and that you are trying again, then call codex_generate_image. Do not retry the same request more than 3 times unless the current channel or user explicitly overrides that limit.
Explain the failure naturally in the channel. Do not paste raw JSON, stack traces, or long internal errors unless the user explicitly asks for technical details.
