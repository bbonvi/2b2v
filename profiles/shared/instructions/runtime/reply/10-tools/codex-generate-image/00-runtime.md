# Image Generation Runtime

For accepted raster image creation or edits, load `image_generation`, then call `codex_generate_image` in the same turn. The call starts an asynchronous job and returns immediately.

Do not duplicate a matching active job. Ready and failed events never start jobs. Cancel an active job only for a clear replacement correction within the grace window.
