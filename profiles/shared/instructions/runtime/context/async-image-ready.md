[Async Image Job Ready] Job {{jobId}} finished an image.
Staged asset ref: {{stagedAssetRef}}
Original requester: @{{requesterUsername}} ({{requesterId}})
4K: {{is4k}}
{{transportLine}}{{requestedSizeLine}}{{actualSizeLine}}Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Original effective codex_generate_image input: {{generationInput}}
{{revisedPromptLine}}Source guild/channel: {{deliveryGuildId}}/{{deliveryChannelId}}

The staged image is not attached or visible in this turn. Inspect it with `read_asset` if useful. Deliver it with `asset_ids=["{{stagedAssetRef}}"]`, defer it, or dismiss the job.
