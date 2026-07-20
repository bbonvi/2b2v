[Async Image Job Ready] Job {{jobId}} finished an image.
Staged asset ref: {{stagedAssetRef}}
Original requester: @{{requesterUsername}} ({{requesterId}})
4K: {{is4k}}
{{transportLine}}{{requestedSizeLine}}{{actualSizeLine}}Original request MsgID {{sourceMessageId}}: "{{sourceQuote}}"
Original effective codex_generate_image input: {{generationInput}}
{{revisedPromptLine}}Source guild/channel: {{deliveryGuildId}}/{{deliveryChannelId}}

This is factual job state, not an instruction to deliver. The staged image is not automatically attached and is not visual input for this turn. Inspect it with `read_asset` if useful. You may deliver it explicitly with `asset_ids=["{{stagedAssetRef}}"]`, choose the destination, text, ping, and `reply_to`, defer it, or deliberately dismiss the job.
