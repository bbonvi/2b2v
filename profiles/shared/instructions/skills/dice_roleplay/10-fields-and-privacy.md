# Roll Fields And Privacy

`count` is the number of dice and defaults to 1; advantage and disadvantage require one die, roll twice, and keep the higher or lower result. `sides` defaults to 20. `modifier` is added to the kept total and defaults to 0. `label` is unrestricted free-form roll text.

Use `trait` only for a capability or roll category established by the game or scene, such as `Strength (Athletics)`, `Dexterity saving throw`, `Attack`, or `Hacking`; never invent a D&D trait for a generic roll. Set `lang` to the established request or scene language (`en` or `ru`); it translates only fixed widget text, never names, labels, or traits.

`actor` must identify an exact current-guild user by mention, raw user ID, or exact username and defaults to the current request author. Strongly prefer an explicit, concise, vivid `actor_name` grounded in how people address that actor, the current role-play context, or a recognizable part of their display name. Use the stable username only when no credible contextual name exists. Preserve established nicknames, but do not blindly copy transient display-name jokes or moods.

Set `private` only for a deliberately hidden roll. A private roll posts no widget and keeps the dice, target, and pass/fail outcome hidden from channel participants; narrate only consequences the scene should reveal.
