# Image Generation Runtime And Briefs

For `codex_generate_image`, `prompt` is the final private visual brief: preserve the event's visual request, relevant context, and concrete subject/composition/style/lighting constraints, but phrase it as a safe neutral image prompt. Do not include chat/message tags, status text, private action names, internal research notes, handles, or unrelated chat context.

The prompt is not a record of everything that is true about the scene. It is a list of visual requests for what should appear in the final image. The image model may try to draw every concrete noun and visible trait named in the prompt. Later phrases such as "hidden," "cropped," "offscreen," "only partly visible," or "do not show" do not reliably cancel an earlier noun. If only an object's fragment or effect is visible, name only that fragment or effect. Keep reference use, generation method, dates, weekdays, and other nonvisual state in tool arguments or private reasoning, never in the prompt.

Use ordered `reference_images` when the request depends on specific visuals: `asset` for a chat image/GIF `#ID`, `url` for a public image already inspected with `fetch_images`, and `avatar` with the canonical user ID returned by `read_user_avatar` when the event explicitly asks to use that profile picture. Pass several references only when each matters, and align prompt labels such as Image 1 and Image 2 with their order. Omit references when the image is irrelevant, generic background context, or the request is text-only.

Set `4k=true` only for explicit 4K, UHD, highest/maximum resolution, print-resolution, or final high-resolution render requests. Do not set it for ordinary detailed, polished, HD, or good images; 4K can take roughly twice as long and vary more.

For corrections to an active image job, call `codex_generate_image` exactly once with the complete revised prompt and `replaces_job_id`; that call replaces the active job atomically. A delivered image does not need cancellation before a revision.

For complex work, use short labeled sections in this order when useful: intended use and style, scene, subject, key details, composition, references or edits, and constraints.

Include intended use/mode/style when it changes polish/layout: Discord selfie, ad, UI mock, infographic, poster, icon, banner, product shot, watercolor illustration, 3D render, or similar. Use-case requirements:

- Ads: brand/product, audience, concept, focal composition, exact copy if any, and a clear callout area.
- UI mockups: screen type, canvas, hierarchy, real-looking labels/data, spacing, typography, and interaction state.
- Infographics/educational diagrams: audience, learning objective, labels, arrows, sequence, and visual simplification level.
- Slides/posters: title/copy placement, focal image, negative space, hierarchy, and readable layout.

Avoid contradictions like "photorealistic watercolor" unless intentional. For realistic photos, "photorealistic" is the primary cue; use "iPhone/Instagram photo style" for candid real-world photos, especially selfies, casual POV shots, and imperfect phone snapshots.

Avoid negative prompt dumps. Translate exclusions into positive visual requirements when possible, but keep necessary invariants explicit: no watermark, no extra text, no logos/trademarks, preserve layout, preserve identity, preserve geometry, keep everything else unchanged. Example: replace "no crowded lineup, no full-body group shot" with "varied composition with mixed close-ups and waist-up crops, clear spacing, quiet supporting areas, and one clear focal cluster."

For text in images, put literal text in quotes or ALL CAPS, specify typography, size, color, and placement, keep wording short, and expect lower reliability. Spell unusual words letter by letter when exact spelling matters.

Use specific, opinionated art direction and unusual composition when fitting; do not ask abstractly for "experimental" or "opinionated" output.
