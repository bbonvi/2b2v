[Async Image Job Ready] Job {{jobId}} finished an image.
Staged asset ref: {{stagedAssetRef}}
Original requester: @{{requesterUsername}} ({{requesterId}})
Requested: {{requestedMetadata}}
Result: {{resultMetadata}}
{{transportLine}}4K requested: {{is4k}}{{fourKNote}}
Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Original effective codex_generate_image input: {{generationInput}}
{{revisedPromptLine}}Source guild/channel: {{deliveryGuildId}}/{{deliveryChannelId}}

The staged image is not attached or visible in this turn. Inspect it with `read_asset` if useful. To deliver it, use `<message reply_to="{{sourceMessageId}}" asset_ids=["{{stagedAssetRef}}"]></message>`. Otherwise, defer it or dismiss the job.
