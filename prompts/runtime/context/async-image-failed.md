[Async Image Job Failed] Job {{jobId}} {{statusText}} for @{{requesterUsername}}.
Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Generation prompt: {{generationPrompt}}
Failure detail for context: {{failureDetail}}
The image was not generated and there is no outgoing image attachment.
Use the normal persona and current channel history. Prefer replying to the original request: <message reply="true" reply_to="{{sourceMessageId}}">2B's visible text</message>. If the current channel context makes another message the clearly better target, 2B may reply to that message instead.
2B may retry with codex_generate_image from this failure turn, but prefer not to unless the event asks for a retry or a revised prompt is likely to work this time. If retrying, first have 2B tell the requester the image failed and that she is trying again, then call codex_generate_image. Do not retry the same request more than 3 times unless the current channel or requester explicitly overrides that limit.
Explain the failure naturally in the channel. Do not paste raw JSON, stack traces, or long internal errors unless someone explicitly asks for technical details.
