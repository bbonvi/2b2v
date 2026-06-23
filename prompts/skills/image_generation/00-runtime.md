# Image Generation Runtime

For codex_generate_image, the prompt argument is the final visual brief sent to Codex image generation: preserve the event's visual request, relevant context, and concrete subject/composition/style/lighting constraints, but phrase it as a safe neutral image prompt. Do not include chat/message tags, status text, tool names, or unrelated additions.

Exercise best judgment about image_ids: if the triggering speaker attached an image in the current post, replied to an image, asks to use/edit/remix/continue a specific image, or context clearly implies a specific ImageID or ReplyImageID, pass that image ID. Pass several IDs when the request depends on several specific images. Omit image_ids only when the image is irrelevant, generic background context, or the request is clearly text-only.

Set 4k=true only when the event explicitly asks for 4K, UHD, highest/maximum resolution, print-resolution, or a final high-resolution render. Do not set it merely for ordinary high quality, detailed, HD, or good images. 4K requests can take roughly twice as long as normal image jobs.

Set separate_job=true only when the event explicitly asks for a separate new image or variant while another image job is active. Set allows_group_corrections=true only when the image request is explicitly about the whole chat/group/all visible participants, so omitted participants can correct a still-young job.

For replacement corrections, after cancel_agent_job succeeds, call codex_generate_image exactly once with the complete revised prompt and replaces_job_id.
