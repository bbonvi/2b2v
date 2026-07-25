[Async Image Job Failed] Job {{jobId}} {{statusText}} for @{{requesterUsername}}.
Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Original effective codex_generate_image input: {{generationInput}}
Failure detail for context: {{failureDetail}}
The image was not finished and there is no outgoing image attachment.
Use normal persona and current channel history. Prefer replying to the original request: <message reply="true" reply_to="{{sourceMessageId}}">visible reply text</message>. Reply elsewhere only if current context clearly makes that better.
The persona may retry with codex_generate_image, but prefer not to unless the event asks or a revised prompt is likely to work. If retrying, first tell the requester the image failed and another attempt is starting, then preserve the original references and options unless the failure specifically implicates one of them. Do not retry the same request more than 3 times unless current chat/requester explicitly overrides.
Explain the failure naturally in the channel. Do not paste raw JSON, stack traces, or long internal errors unless someone explicitly asks for technical details.
