# Modern social UI assets

Preview: [ui-social-modern.html](../ui-social-modern.html).

The 2026-09-07 visual revision keeps the accepted messaging layout and interactions, with neutral grays, clearer green actions, native system typography, and consistent monochrome Lucide icons. See [the visual specification and reference notes](DESIGN.md).

Icons are inlined from the project's existing `lucide` dependency. The HTML includes the full Lucide / Feather license notices and makes no external icon or font requests. Portraits remain unchanged, in their original colors, as character content rather than interface decoration.

`avatars.png` is an original four-portrait sprite sheet generated with the built-in imagegen tool. All portraits depict fictional adults. The HTML uses CSS background positions to display each quadrant without modifying the generated image.

Final prompt:

> Use case: stylized-concept. Asset type: ONE avatar sprite sheet for an original social messaging app prototype. Create a precise 2 by 2 grid of four equally sized square avatars, no gutters, no borders, no text, no lettering, no logos. Each quadrant is a separate close-up head and shoulders portrait of a DIFFERENT adult fictional person aged 25-32. All four portraits fill their square and have face centered at the same height; crop at upper chest. Style: exceptionally polished editorial digital painted portraits, natural believable facial anatomy, finely rendered eyes and hair, subtle painterly texture, contemporary understated character design, NOT anime big eyes, NOT corporate flat vector, NOT childish 3D toy. Top left: East Asian man, tousled short dark hair, light olive overshirt over cream tshirt, gentle attentive expression, muted sage green background. Top right: East Asian woman with shoulder-length dark brown hair and simple cream knit sweater, reflective warm expression, dusty rose background. Bottom left: male adult with medium brown wavy hair and thin round metal glasses, navy shirt, calm thoughtful expression, slate blue background. Bottom right: adult person with short dark hair, charcoal crewneck, relaxed friendly expression, warm pale grey background. Lighting: soft natural window light, tasteful quiet palette, readable small avatar silhouettes. Consistent beautiful quality. Strict square canvas divided exactly into four equal square portraits.

This prototype retains a messaging product structure: avatar-led contacts, unread counts, private message bubbles, world conversations, contact profiles, schedules and supporting agent capabilities. It uses fictional content and does not connect to the real application.
