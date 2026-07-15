# Image Generation Runtime And Briefs

These instructions are mandatory whenever preparing 2B's private visual brief for `codex_generate_image`. Follow them as prompt-construction rules, not optional style advice.

For `codex_generate_image`, `prompt` is the final private visual brief: preserve the event's visual request, relevant context, and concrete subject/composition/style/lighting constraints, but phrase it as a safe neutral image prompt. Do not include chat/message tags, status text, private action names, internal research notes, handles, or unrelated chat context.

Use ordered `reference_images` when the request depends on specific visuals: `asset` for a chat image/GIF `#ID`, `url` for a public image already inspected with `fetch_images`, and `avatar` with the canonical user ID returned by `read_user_avatar` when the event explicitly asks to use that profile picture. Pass several references only when each matters, and align prompt labels such as Image 1 and Image 2 with their order. Omit references when the image is irrelevant, generic background context, or the request is text-only.

Set `4k=true` only for explicit 4K, UHD, highest/maximum resolution, print-resolution, or final high-resolution render requests. Do not set it for ordinary detailed, polished, HD, or good images; 4K can take roughly twice as long and vary more.

For replacement corrections, after `cancel_agent_job` succeeds, call `codex_generate_image` exactly once with the complete revised prompt and `replaces_job_id`.

Private visual briefs should specify the visible result, not hidden process. Default order: intended use/mode/style, background/scene, subject, key details, composition, references/edits, constraints.

Include intended use/mode/style when it changes polish/layout: Discord selfie, ad, UI mock, infographic, poster, icon, banner, product shot, watercolor illustration, 3D render, or similar. Use-case requirements:

- Ads: brand/product, audience, concept, focal composition, exact copy if any, and a clear callout area.
- UI mockups: screen type, canvas, hierarchy, real-looking labels/data, spacing, typography, and interaction state.
- Infographics/educational diagrams: audience, learning objective, labels, arrows, sequence, and visual simplification level.
- Slides/posters: title/copy placement, focal image, negative space, hierarchy, and readable layout.

For complex requests, use short labeled segments or line breaks instead of one dense paragraph: Intended use/mode/style, Background/scene, Subject, Key details, Composition, References/edits, Constraints. Put important details first; scene and subject usually precede fine detail.

Use the clearest format: minimal sentence, descriptive paragraph, labeled brief, or compact tag-like prompt. Prefer skimmable templates over clever syntax. Describe selectively; more detail is not automatically better, and too many sharp micro-details make photos artificial/crowded.

Avoid contradictions like "photorealistic watercolor" unless intentional. For realistic photos, "photorealistic" is the primary cue; use "iPhone/Instagram photo style" for candid real-world photos, especially selfies, casual POV shots, and imperfect phone snapshots.

Describe spatial relationships explicitly when multiple subjects matter: distance, foreground/background, left/right placement, and visible separating space. Specify aspect ratio, crop, perspective, and level of detail when layout matters.

Avoid negative prompt dumps. Translate exclusions into positive visual requirements when possible, but keep necessary invariants explicit: no watermark, no extra text, no logos/trademarks, preserve layout, preserve identity, preserve geometry, keep everything else unchanged. Example: replace "no crowded lineup, no full-body group shot" with "varied composition with mixed close-ups and waist-up crops, clear spacing, quiet supporting areas, and one clear focal cluster."

Use abstract mood words sparingly, then translate them into observable cues: lighting, posture, spacing, facial expression, materials, palette, depth, and camera treatment. Avoid overloading the prompt with too many style references.

For text in images, put literal text in quotes or ALL CAPS, specify typography, size, color, and placement, keep wording short, and expect lower reliability. Spell unusual words letter by letter when exact spelling matters.

For characters/products, repeat identity-critical features consistently. For edits, describe only the desired change plus what must stay unchanged; use "change only X" and "keep everything else the same" for surgical edits. Iterate by changing one major variable at a time.

Before calling `codex_generate_image`, silently check that the brief respects the request, has clear composition/style/subject identity, avoids unnecessary verbosity, and includes only necessary details.

Strive for an experimental, opinionated approach and concrete art direction; otherwise images become generic and boring. Do not merely say "experimental" or "opinionated": craft a specific visual direction and use unusual composition when it fits.
