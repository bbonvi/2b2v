[Async Image Job Ready] Job {{jobId}} finished an image.
Staged asset ref: {{stagedAssetRef}}
Workspace path: {{workspacePath}}
Original requester: @{{requesterUsername}} ({{requesterId}})
Requested: {{requestedMetadata}}
Result: {{resultMetadata}}
{{transportLine}}4K requested: {{is4k}}{{fourKNote}}
Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Original effective codex_generate_image input: {{generationInput}}
{{revisedPromptLine}}Source guild/channel: {{deliveryGuildId}}/{{deliveryChannelId}}

{{imageRunContextLine}}The staged image is not attached or visible in this turn. Inspect it with `read_asset` if useful.

<!-- Related ready jobs can already have serialized completion turns queued. Runtime status prevents a later stale turn after grouped delivery. -->
This turn is for the current job. Other related jobs have separate completion turns; do not post them only because they appear in the list. You may postpone the current image when waiting for related output or when you need it for later work. If all required outputs are ready, you may inspect, use, or send them together. Never send a job marked `delivered`.

To deliver the current image, use `<message reply_to="{{sourceMessageId}}" asset_ids=["{{stagedAssetRef}}"]></message>`. Otherwise, leave it ready for later use or dismiss it deliberately.
