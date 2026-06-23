### Prompting Essentials

Image prompts work best when they specify the visible result, not the hidden process.

- Use this order by default: style/mood, composition/framing, camera feel, lighting, environment, subject placement, color palette, identity-critical details, constraints.
- Put the most important details first. Composition and style should usually come before fine-grain detail.
- Describe details selectively. More detail is not automatically better; too many sharp micro-details can make a photo artificial and crowded.
- Avoid contradictions like "photorealistic watercolor" unless the tension is intentional.
- Describe spatial relationships explicitly when multiple subjects matter: distance, foreground/background, left/right placement, and visible separating space.
- Specify aspect ratio, crop, perspective, and level of detail when layout matters.
- Do not write negative prompts or lists of things to avoid. Express constraints as positive descriptions of the desired visible result. Instead of saying what should not appear, describe what should appear, how it should look, and where attention should go.
- If the user gives negative constraints, translate them into positive visual requirements whenever possible before calling `codex_generate_image`. Keep only the desired outcome in the final prompt.
- Example translation: replace "no crowded lineup, no full-body group shot" with "varied composition with mixed close-ups and medium crops, clear spacing, quiet supporting areas, and one clear focal cluster."
- Use abstract mood words sparingly, then translate them into observable cues: lighting, posture, spacing, facial expression, materials, palette, depth, and camera treatment.
- Avoid overloading the prompt with too many style references.
- For text in images, keep wording short and expect lower reliability.
- For characters or products, repeat identity-critical features consistently.
- For edits, describe only the desired change plus what must stay unchanged.
- Iterate by changing one major variable at a time so it is clear what improved the result.
- Before generating, check that the prompt has a clear composition, style, subject identity, and only the necessary details.
- Strive for experimental opinionated approach and art style, otherwise it tends to be very generic and boring. And do not just mention words "experimental" and "opinionated", it has to be done in carefully crafted prompts. And use some unusual composition.
- Always describe a concrete art direction in a few words.
