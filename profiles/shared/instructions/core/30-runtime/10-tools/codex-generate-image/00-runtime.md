# Image Generation Runtime

<!-- This rule must be visible before the deferred image skill loads. -->
For raster image creation or edits that you choose to start now, load `image_generation`, then call `codex_generate_image` in the same response run. When acknowledging the work, put the message and `codex_generate_image` call in the same model output; do not attach the acknowledgment only to `load_skill`. The image call starts an asynchronous job and returns immediately.

Do not duplicate a matching active job. A ready or failed event does not by itself require a new job. Cancel an active job only for a clear replacement correction within the grace window.
