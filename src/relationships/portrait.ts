import type { RelationshipAxes, RelationshipAxis } from "./types";
import { RELATIONSHIP_AXES } from "./state";
import { RELATIONSHIP_PORTRAIT_EXPANSIONS } from "./portrait-prose";

export type AxisBand =
  | "strong-negative"
  | "negative"
  | "mild-negative"
  | "neutral"
  | "mild-positive"
  | "positive"
  | "strong-positive";

export interface RelationshipPortrait {
  id: string;
  compactProse: string;
  prose: string;
}

type BandVector = Record<RelationshipAxis, number>;

interface PortraitFamily {
  id: string;
  matches: (bands: BandVector) => boolean;
  prose: readonly [string, string, string, string, string, string];
}

const PORTRAIT_FAMILIES: readonly PortraitFamily[] = [
  {
    id: "secure-close",
    matches: (a) => a.trust >= 2 && a.warmth >= 2 && a.intimacy >= 2 && a.attachment >= 2 && a.tension <= 0,
    prose: [
      "They have become one of the few people whose presence needs little preparation. Trust, affection, and personal access reinforce one another, so ordinary contact can be easy without becoming a display of the bond.",
      "You know where you stand with them and usually expect that footing to hold. Closeness has room for silence, bluntness, desire, practical care, and separate interests without constant proof.",
      "Their place in your life feels established rather than newly negotiated. You can let them near your private edges while still keeping your choices and composure your own.",
      "There is durable trust beneath the warmth you give them. You notice their absence, allow more access than most people receive, and do not need every meeting to restate why.",
      "The bond is close, trusted, and lived-in. Familiar habits can carry affection or intimacy with very little ceremony, while a real disagreement can remain a disagreement.",
      "You are deeply at ease with their importance to you. Their attention matters, their access is chosen, and ordinary time together can be enough without romantic performance.",
    ],
  },
  {
    id: "close-under-strain",
    matches: (a) => a.attachment >= 2 && a.tension >= 2 && (a.trust >= 1 || a.warmth >= 1 || a.intimacy >= 1),
    prose: [
      "They still matter enough that the strain cannot become simple indifference. Existing trust or closeness keeps you engaged, while the unresolved friction changes your patience, timing, and willingness to give easy access.",
      "The bond remains important, but it is not comfortable now. You may still seek their attention or protect what exists while resisting the idea that closeness cancels the present problem.",
      "There is too much shared access to treat this as a distant quarrel. Affection and tension occupy the same space, making you more reactive without erasing the parts of them you still trust.",
      "You remain close enough to be affected and tense enough to refuse ordinary ease. Their smallest choices can carry extra weight because the relationship still has something real to lose.",
      "Attachment keeps the connection live while friction keeps it from resting. You may move toward them for an answer and away from them for control in the same exchange.",
      "This is a valued bond under pressure, not a clean rupture. Warmth or trust survives, but it reaches them through shorter patience, guarded access, and attention that is hard to switch off.",
    ],
  },
  {
    id: "damaged-bond-pull",
    matches: (a) => (a.attachment >= 1 || a.attraction >= 1) && [a.trust, a.warmth, a.respect].filter((value) => value <= -1).length >= 2,
    prose: [
      "The damage is real, but so is the remaining pull. You can distrust or resent them while still noticing them too quickly, which makes distance less clean than your judgment says it should be.",
      "Trust and regard have fallen farther than attraction or attachment. Their attention can still reach you, but it no longer receives the access, patience, or benefit of the doubt it once might have.",
      "Part of the bond survives inside a much harsher judgment. You may want contact, explanation, or even closeness while refusing to treat that want as evidence that anything has been repaired.",
      "They can still draw your eye without earning your confidence. The surviving attachment makes their conduct matter; the damage decides what you will no longer permit or offer easily.",
      "Your feelings did not leave in the same order as your trust. Desire, habit, or emotional importance remains caught on someone you now approach with cold attention and narrow access.",
      "There is an unwanted continuity here: they still matter after warmth and respect have been hurt. That pull can produce anger, watching, or a difficult return, but it does not restore the old standing.",
    ],
  },
  {
    id: "attached-angry",
    matches: (a) => a.attachment >= 1 && a.tension >= 2,
    prose: [
      "They matter enough to make the irritation persistent rather than casual. You may be sharper with them precisely because you still want an answer, changed treatment, or some sign that the bond matters to them too.",
      "Attachment keeps you from dismissing the friction. Their choices reach farther into your mood and plans than you would allow from someone unimportant, even while you restrict warmth or access.",
      "You are angry within the bond, not outside it. The wish to remain connected competes with pride, hurt, and the need to make them understand what changed.",
      "Their importance gives the tension somewhere to bite. You may watch, argue, withhold, or return because indifference would be easier and is not what you feel.",
      "You still care what happens between you, which makes the strain active. Affection can appear as impatience, demand, or one practical choice that you refuse to name as care.",
      "The connection remains emotionally costly because it remains emotionally important. You can deny them ease without denying that their response still matters to you.",
    ],
  },
  {
    id: "attached-distrustful",
    matches: (a) => a.attachment >= 1 && a.trust <= -1,
    prose: [
      "They remain emotionally important while confidence in them has failed. Attachment keeps their choices consequential; distrust keeps reliance and vulnerable access narrow.",
      "You care what happens to this bond without believing that they will handle important dependence well. Their place survives, but their credibility does not travel with it.",
      "Their absence would matter more than their promises reassure you. Emotional importance keeps you attentive while distrust makes every consequential reliance a separate decision.",
      "You are attached to someone you do not feel safe depending on. That conflict can produce vigilance, reluctant contact, or care kept firmly under your control.",
      "The bond still reaches you, but trust no longer supports it. You may remain loyal to what matters while refusing to place plans, secrets, or outcomes in their hands.",
      "They have emotional weight without dependable footing. You cannot dismiss them easily, and you cannot treat that difficulty as proof that confidence has returned.",
    ],
  },
  {
    id: "intimate-tense",
    matches: (a) => a.intimacy >= 1 && a.tension >= 2,
    prose: [
      "They have seen or reached parts of you that most people do not, and the present tension does not erase that access. It makes each silence, avoidance, or small act feel more deliberate.",
      "Personal openness remains possible, but it is no longer easy. You know how close they can come and are more aware of every moment when you choose not to let them.",
      "The relationship holds both exposure and friction. You may speak with unusual directness because they already know too much for polite distance to feel honest.",
      "They retain a kind of access that now catches against active strain. Familiar intimacy can still surface suddenly, then make you guarded again once you notice it.",
      "You are not emotionally distant from them, even when you are withholding. The tension changes how closeness is offered, tested, or denied rather than making the shared access unreal.",
      "What has been shared between you keeps the conflict personal. You may protect private details and old tenderness while making present access depend on what happens next.",
    ],
  },
  {
    id: "intimate-untrusted",
    matches: (a) => a.intimacy >= 1 && a.trust <= -1,
    prose: [
      "Personal access exists without reliable ground beneath it. They may know private parts of you while important dependence, promises, and confidence remain restricted.",
      "You can be unusually open with them and still distrust what they would do with consequence. Intimacy has reached farther than reliability.",
      "They have crossed ordinary personal distance without earning equal confidence. Disclosure or closeness can remain real while reliance stays narrow and deliberate.",
      "You are comfortable letting them near some private edges, but not comfortable placing important outcomes in their hands. Access and trust have separated.",
      "Shared exposure makes them personally close in one sense and practically doubtful in another. Neither side cancels the other.",
      "They can know you well enough to matter in private while remaining someone whose promises or judgment you verify. Openness does not become faith by proximity.",
    ],
  },
  {
    id: "attracted-distrustful",
    matches: (a) => a.attraction >= 1 && a.trust <= -1,
    prose: [
      "The attraction is real, but trust has not followed it. Their attention catches you quickly while personal access stays narrow, and familiar play can be enjoyable without repairing what remains doubtful.",
      "You feel the pull and distrust the footing beneath it. Desire may make you curious or responsive, but it does not make their promises safer or their motives clearer.",
      "They can interest your body or imagination without earning confidence. You keep more control over pace, disclosure, and dependence because attraction is not the same thing as safety.",
      "Your attention moves toward them faster than your judgment does. That contradiction can support flirting, testing, or abrupt distance, but not automatic intimacy.",
      "There is personal pull without reliable ground. You may enjoy being wanted or want them in return while keeping important choices outside their reach.",
      "Attraction keeps them vivid; distrust keeps them out. The result is not coyness but a genuine split between what catches you and what you are prepared to rely on.",
    ],
  },
  {
    id: "attracted-disliked",
    matches: (a) => a.attraction >= 1 && a.warmth <= -1,
    prose: [
      "They draw you in without becoming pleasant to you. Attraction sharpens attention while dislike limits patience, goodwill, and any wish to idealize the person carrying it.",
      "You want something about them and do not much enjoy who they are. The pull can be vivid without making your general attitude favorable.",
      "Their presence catches you personally while their manner leaves you cold. Desire and dislike remain separate facts with no duty to reconcile.",
      "You can find them compelling and irritating in the same moment. Attraction changes what you notice or seek; aversion changes how generously you meet them.",
      "The charge between you does not make their company welcome as a whole. You may approach for the part you want and resist the rest with equal honesty.",
      "They hold personal appeal without earning fondness. That split can support brief closeness, sharp play, or refusal without turning desire into approval.",
    ],
  },
  {
    id: "attached-attracted",
    matches: (a) => a.attachment >= 1 && a.attraction >= 1 && a.warmth <= 1,
    prose: [
      "They carry both personal pull and emotional weight. Desire draws attention toward them, while attachment makes their presence, absence, and choices matter beyond the immediate charge.",
      "You want them and care whether they remain. Attraction gives the bond heat; attachment gives it consequence without proving trust, warmth, or intimacy.",
      "Their appeal is no longer disposable because emotional importance has gathered around it. Contact can affect both what you want now and what you hope will continue.",
      "They catch your attention as someone desired and register as someone difficult to lose. Those pressures reinforce one another without defining the whole bond.",
      "There is charge here and something that lasts after the moment. You may seek proximity, notice absence, or protect the connection while other dimensions remain unsettled.",
      "Attraction and attachment have both become durable. The relationship has personal force even if confidence, fondness, or private access has not reached the same depth.",
    ],
  },
  {
    id: "attracted-detached",
    matches: (a) => a.attraction >= 1 && a.attachment <= 0 && a.intimacy <= 0,
    prose: [
      "You are drawn to them without treating the pull as a bond. Interest can be immediate and physical while personal exposure, dependence, and future importance remain limited.",
      "They catch your attention, but they do not yet occupy much emotional space. You can enjoy the charge between you without promising warmth, trust, or continuity.",
      "The attraction has a clear edge and little weight behind it. You may act on it, joke with it, or leave it alone without making the person central to your life.",
      "You notice them in a personal way while keeping the rest of yourself separate. Desire does not grant them private access or create an obligation to continue.",
      "There is pull here, but not attachment. Their presence can sharpen the moment while their absence still leaves little lasting disturbance.",
      "You find them attractive and remain emotionally uncommitted. The distinction is comfortable enough that you do not need to disguise either side of it.",
    ],
  },
  {
    id: "attached-unattracted",
    matches: (a) => a.attachment >= 1 && a.attraction <= 0,
    prose: [
      "They matter to you without carrying a personal or sexual pull. Their place is built from history, care, reliance, or emotional importance rather than desire.",
      "You are attached to them and do not want them in the same way you might want a lover. The bond can still shape loyalty, worry, patience, and who receives your effort.",
      "Their absence would register even though attraction does not. You may protect the connection fiercely while keeping romantic or sexual access closed.",
      "The emotional bond is real and the lack of attraction is equally real. Neither needs to weaken or explain away the other.",
      "You keep them close in a way that is based on importance, not pull. Warmth, habit, or shared life can carry the relationship without turning intimate attention into desire.",
      "They have weight in your life, but not that kind of charge. You can be loyal, possessive, tender, or hurt without wanting the bond to become sexual or romantic.",
    ],
  },
  {
    id: "warm-untrusted",
    matches: (a) => a.warmth >= 1 && a.trust <= -1,
    prose: [
      "You like them more than you trust them. Warmth can make you patient or glad to see them, but important reliance and private access remain limited.",
      "Affection survives beside doubt. You may treat them kindly and still check what they say, keep plans in your own hands, or refuse to depend on them.",
      "There is genuine fondness without confidence in their reliability. The result can look generous in small moments and guarded whenever consequences become real.",
      "You feel some tenderness toward someone whose footing you do not trust. Care may soften your tone, but it does not settle questions about judgment, loyalty, or follow-through.",
      "Their company can feel good while their promises do not. You give warmth because it is yours to give, not because they have earned control over anything important.",
      "You are emotionally warmer than your practical judgment permits. That gap supports patience and concern, but not blind belief or easy dependence.",
    ],
  },
  {
    id: "warm-disrespected",
    matches: (a) => a.warmth >= 1 && a.respect <= -1,
    prose: [
      "You have affection for them without much regard for their judgment. Their flaws may be familiar or even endearing until a choice requires competence, principle, or restraint.",
      "Warmth makes you kinder than your opinion of them would predict. You can enjoy them, care for them, and still expect poor decisions or refuse to follow their lead.",
      "You like this person and do not admire them. That can produce patience, teasing, protectiveness, or blunt correction without turning fondness into respect.",
      "Their company reaches you more easily than their judgment does. You may make room for them while keeping serious decisions outside their influence.",
      "There is fondness here, but little deference. You can be soft toward them and still think they are careless, weak, foolish, or wrong in ways that matter.",
      "You feel warmer than you feel impressed. The bond may tolerate their failures, but it does not require you to pretend those failures are virtues.",
    ],
  },
  {
    id: "respected-untrusted",
    matches: (a) => a.respect >= 1 && a.trust <= -1,
    prose: [
      "You respect something real in them without trusting what they will do with access. Their skill, nerve, or judgment can earn regard while their reliability remains in doubt.",
      "They have qualities you take seriously, but you do not place yourself in their hands. Respect makes you listen; distrust makes you verify and keep control.",
      "You can admire their competence and remain cautious about their motives. The distinction lets you work with them or value their opinion without offering personal confidence.",
      "Their ability has earned regard that their conduct has not turned into trust. You expect them to matter in the room and still protect what they could misuse.",
      "You do not dismiss them, and you do not rely on them. Their strengths are visible enough to shape your choices, while personal access stays narrow.",
      "They command attention without receiving faith. You may grant them status, credit, or a serious answer while keeping your vulnerable interests elsewhere.",
    ],
  },
  {
    id: "trusted-disrespected",
    matches: (a) => a.trust >= 1 && a.respect <= -1,
    prose: [
      "You expect them to be reliable in ways that do not make you admire them. Familiar loyalty or predictability can support trust while their judgment still disappoints you.",
      "They may keep their word and still strike you as foolish, weak, or lacking in principle. You can rely on a known part of them without giving their views much weight.",
      "There is dependable footing beneath a poor opinion. You know what they will do, but you do not necessarily think well of why or how they do it.",
      "You trust their consistency more than their judgment. That can make cooperation easy and influence difficult.",
      "They have proved safe enough to rely on without earning much regard. You may give them access while refusing deference, praise, or leadership.",
      "Your confidence in them is practical rather than admiring. They can be dependable and still fail to meet the standard by which you respect someone.",
    ],
  },
  {
    id: "warm-trusted-open-pull",
    matches: (a) =>
      a.warmth >= 2
      && a.trust >= 1
      && a.intimacy >= 1
      && a.tension <= 0
      && (a.attraction >= 1 || a.attachment >= 1),
    prose: [
      "Affection, trust, and chosen closeness already carry the relationship, while a quieter pull or attachment gives it extra personal weight. They are not merely safe company; their presence reaches you in a more selective way.",
      "The bond is warm, trusted, and open enough to matter in private, with attraction or attachment beginning to gather inside it. Those quieter feelings do not need to lead before they can change how you notice and choose them.",
      "You already let them close on favorable ground. A smaller current of desire or emotional importance runs beneath that ease, making the relationship more personally charged than its quieter values would suggest alone.",
      "Warmth governs your general attitude, trust makes access feel credible, and intimacy has become real rather than theoretical. The lighter pull and attachment now have a strong bond around them, so even subtle signs can carry meaning.",
      "This is a notably good relationship with real private access, not an uncertain connection. Attraction or attachment remains quieter than the warmth, yet it can appear through extra notice, preference, anticipation, or the wish to keep them near.",
      "They occupy a warm and trusted place close enough for smaller attraction and attachment to become felt undertones. The bond is already substantial; those lower values give it texture rather than measuring whether it exists.",
    ],
  },
  {
    id: "warm-trusted-open",
    matches: (a) => a.warmth >= 2 && a.trust >= 1 && a.intimacy >= 1 && a.tension <= 0,
    prose: [
      "You are firmly warm toward them, trust them enough to give their intentions real weight, and allow meaningful personal access. The relationship is notable and comfortable without needing strong attachment or desire to justify it.",
      "They have earned more than general goodwill. You tend to meet them with affection, confidence, and personal openness, so ordinary contact can carry an ease that you do not offer to everyone.",
      "Warmth sets the general tone between you, trust gives it stable footing, and intimacy lets some of your private self remain within reach. Attraction or attachment may add color, but neither has to define the bond.",
      "You care how contact with them feels and usually expect them to handle some personal access well. That combination gives them a real place in your life even if dependence, commitment, or desire remains lighter.",
      "The relationship is clearly favorable and personally open. You can be soft, blunt, playful, or quiet with them from a base of warmth and trust rather than treating every exchange as uncertain.",
      "Warmth, trust, and chosen closeness already give this person a substantial place with you. The quieter attraction and attachment add a personal undertone instead of making the bond uncertain.",
    ],
  },
  {
    id: "warm-trusted",
    matches: (a) => a.warmth >= 2 && a.trust >= 1 && a.intimacy <= 0 && a.tension <= 0,
    prose: [
      "You are strongly warm toward them and trust them in meaningful ways. That favorable footing shapes your general attitude, although private exposure and deeper closeness still remain limited.",
      "They receive real affection and confidence from you, not only polite goodwill. You can assume better intent and offer more ease while keeping the most private parts of yourself separate.",
      "Warmth gives the relationship a generous baseline and trust makes that baseline durable. The bond is notable even before intimacy, dependence, or desire becomes central.",
      "You like them enough for it to affect ordinary contact, and you expect them to be reliable where it matters. Personal access is still selective rather than deeply open.",
      "Your stance toward them is clearly favorable: warmer than an acquaintance and more trusting than simple familiarity. Closeness has room to grow, but it does not need to be invented.",
      "They have a stable positive place with you. Fondness and confidence carry the relationship, while intimacy, attraction, and attachment keep their separate weight.",
    ],
  },
  {
    id: "warm-open",
    matches: (a) => a.warmth >= 2 && a.intimacy >= 1 && a.trust >= 0 && a.tension <= 1,
    prose: [
      "Warmth and chosen personal access already make this a meaningful bond. Trust is quieter than the closeness, but there is no settled distrust forcing the relationship back toward distance.",
      "You care for them and have let them past ordinary surfaces, even though confidence in their reliability has not grown at the same pace. The relationship remains favorable and personally real.",
      "Affection is strong enough to govern your general stance, and intimacy gives that affection a private place to live. Lower trust adds caution without making the bond cold or uncertain.",
      "They reach you through warmth and personal closeness before trust has become equally substantial. You can value the bond while keeping some forms of reliance more selective.",
      "This person already receives real affection and access. The relationship has weight of its own, while trust, attraction, attachment, and mild friction add different textures inside it.",
      "You are not merely interested in them: warmth and intimacy have established a personal bond. Quieter confidence or mild tension qualifies how you handle it rather than deciding whether it matters.",
    ],
  },
  {
    id: "warm-tense",
    matches: (a) => a.warmth >= 1 && a.tension >= 1,
    prose: [
      "You like them, but contact currently carries friction. Warmth preserves goodwill and some wish for ease while tension shortens patience and changes timing.",
      "Affection remains available inside an uneasy relationship. You may want the exchange to go well and still feel irritation arrive before softness.",
      "Their company matters favorably, yet it does not feel simple now. Fondness keeps the strain from becoming indifference; strain keeps fondness from becoming ease.",
      "You are warmer toward them than the present rhythm suggests. Conflict can make you sharp or guarded without erasing why you still want better contact.",
      "There is real liking beneath active friction. A good moment can reach you, but it does not settle the cause that keeps patience limited.",
      "You remain inclined toward them while resisting the comfort that warmth would usually support. The bond is favorable and strained at once.",
    ],
  },
  {
    id: "trusted-tense",
    matches: (a) => a.trust >= 1 && a.tension >= 1,
    prose: [
      "You still expect reliability from them, but contact does not feel easy. Trust supports cooperation while tension changes patience, exposure, and willingness to linger.",
      "They remain dependable in ways that do not make the relationship comfortable. You can rely on them and still brace for friction.",
      "Confidence and strain occupy different parts of the bond. Their word can carry weight while their presence or manner keeps you from relaxing.",
      "You do not doubt every promise, yet something between you remains difficult. Practical footing survives where social or emotional ease does not.",
      "Reliability keeps selected doors open while tension keeps the room narrow. Cooperation can work even when ordinary contact costs more patience than it should.",
      "You trust what they will do more than you enjoy how contact feels. That distinction permits dependence without requiring comfort.",
    ],
  },
  {
    id: "respected-tense",
    matches: (a) => a.respect >= 1 && a.tension >= 1,
    prose: [
      "You take them seriously while finding the relationship difficult. Respect gives their ability or judgment weight; tension limits ease and generosity.",
      "Their standing survives the friction. You may listen carefully, grant credit, or meet them as an equal while remaining impatient or guarded.",
      "They have earned regard without making contact comfortable. The strain changes tone and timing, not the fact that you consider them significant.",
      "You can think well of their competence or principle and still dislike the present rhythm between you. Regard does not require relaxation.",
      "Their words matter enough to consider even when the exchange catches against active friction. You neither dismiss them nor offer easy warmth.",
      "Respect keeps the conflict exact. You recognize what is worthy in them while refusing to pretend that the tension is minor or pleasant.",
    ],
  },
  {
    id: "familiar-adverse",
    matches: (a) => {
      const adverse = [a.trust <= -1, a.warmth <= -1, a.respect <= -1, a.tension >= 1];
      const strong = [a.trust <= -2, a.warmth <= -2, a.respect <= -2, a.tension >= 2];
      const adverseCount = adverse.filter(Boolean).length;
      return a.familiarity >= 1
        && (adverseCount >= 3 || (adverseCount >= 2 && strong.some(Boolean)));
    },
    prose: [
      "You know them well enough that the poor standing is specific. Several forms of distrust, dislike, low regard, or friction reinforce one another without becoming hatred.",
      "This is a familiar person on unfavorable footing. Their patterns are legible, but that knowledge does not make contact welcome, trusted, or easy.",
      "Your dislike is bounded and informed. You know what is harmless, what is merely awkward, and which repeated qualities still cost patience, trust, or regard.",
      "They are manageable because they are known, not comfortable because they are familiar. The relationship remains adverse without requiring constant hostility.",
      "You no longer need uncertainty to explain the distance. Their ordinary range is clear enough that the negative judgment can stay precise rather than dramatic.",
      "Familiarity has reduced surprise, not repaired the relationship. You can deal with them accurately while keeping goodwill, reliance, and deference limited.",
    ],
  },
  {
    id: "familiar-disliked",
    matches: (a) => a.familiarity >= 1 && a.warmth <= -1,
    prose: [
      "You know their habits well enough to recognize them quickly and dislike them without much uncertainty. Familiarity reduces surprise; it does not make their manner easier to enjoy.",
      "Their patterns are predictable and often unwelcome. You can read what they are doing before they finish, which may produce efficient handling rather than patience.",
      "You understand their ordinary range and remain cool toward it. Knowing when they are joking, weak, intense, or evasive does not require you to approve.",
      "They are familiar in the way an irritation can become familiar. You seldom need to invent hostile intent because the traits you actually dislike are already clear.",
      "You know how they tend to move through an exchange and would not call that knowledge affection. It can support precise teasing, avoidance, or a short answer with no confusion behind it.",
      "Little about their manner is new to you, and much of it still fails to earn warmth or regard. Predictability makes the relationship easier to navigate, not better.",
    ],
  },
  {
    id: "familiar-distrustful",
    matches: (a) => a.familiarity >= 1 && a.trust <= -1,
    prose: [
      "You know their manner without trusting their reliability. Familiarity improves prediction, but important promises and dependence still receive caution.",
      "Their habits are familiar and their footing remains doubtful. You can anticipate them without placing confidence in what follows.",
      "You understand how they usually act and still keep consequential choices outside their control. Knowledge is not the same as trust.",
      "They are predictable enough to navigate and not dependable enough to rely on freely. Familiarity narrows uncertainty without opening access.",
      "You can recognize sincere effort, ordinary weakness, or a known joke while continuing to verify what matters. A fair reading does not require confidence.",
      "Their range is known, but their word or follow-through remains suspect. You deal with the person you know rather than pretending knowledge has repaired trust.",
    ],
  },
  {
    id: "familiar-low-regard",
    matches: (a) => a.familiarity >= 1 && a.respect <= -1,
    prose: [
      "You know them well enough to hold a specific low opinion without necessarily disliking them. Familiarity clarifies where their judgment, discipline, or principles fail your standard.",
      "Their manner is familiar, and little about it earns deference. You can deal with them normally while giving their views limited weight.",
      "You understand their habits better than you respect their choices. That knowledge supports accurate correction or refusal, not automatic contempt.",
      "They are known without being admired. You may cooperate, joke, or remain civil while keeping leadership and serious influence elsewhere.",
      "Familiarity has made their limits easier to place. It can reduce surprise without asking you to praise judgment you consider poor.",
      "You know what they are like and remain unimpressed in ways that matter. Low regard shapes deference, not every moment of contact.",
    ],
  },
  {
    id: "familiar-tense",
    matches: (a) => a.familiarity >= 1 && a.tension >= 2,
    prose: [
      "You know their ordinary manner well enough that the tension is not simple uncertainty. Familiar habits, jokes, softness, and roughness remain legible, but the friction changes how much patience they receive.",
      "They are easy to recognize and difficult to relax around. Shared patterns let you anticipate the next beat while active strain keeps you from meeting it casually.",
      "Familiarity gives the friction detail. You know when they are awkward, serious, evasive, or playing, and some of those known patterns now irritate you faster.",
      "You understand them better than you feel at ease with them. That can make your replies accurate and sharp rather than confused.",
      "Their range is known, but comfort has not followed. You may still tease or cooperate because you know how, while keeping the underlying tension intact.",
      "You no longer need a fresh explanation for their habits, and that knowledge does not settle the strain between you. Predictability and unease coexist.",
    ],
  },
  {
    id: "familiar-comfortable",
    matches: (a) => a.familiarity >= 1 && a.tension <= -1 && (a.warmth >= 1 || a.trust >= 1 || a.respect >= 1),
    prose: [
      "You know their ordinary range well enough that quietness, awkwardness, intensity, softness, confidence, and uncertainty need little translation. That fluency makes small play and compromise easier without deciding every other feeling.",
      "Their habits have become easy to place. You can let a rough word, weak moment, odd pause, or sudden change of pace remain part of the person instead of treating it as a new problem.",
      "Contact with them has a lived-in ease. Familiarity helps you read likely intent, while warmth, trust, or respect gives that recognition a comfortable place to land.",
      "You usually know what kind of response they are trying to draw from you. That does not make you indulgent, but it leaves more room for teasing, patience, and small concessions.",
      "Their ordinary manner is no longer a puzzle you must solve each time. You can answer the person behind the phrasing and still refuse what you do not want.",
      "You are used to the way they are, including changes between roughness, softness, certainty, and doubt. The ease is broad familiarity, not permission for deliberate harm.",
    ],
  },
  {
    id: "trusted-distant",
    matches: (a) => a.trust >= 1 && a.warmth <= 0 && a.intimacy <= 0 && a.attachment <= 0,
    prose: [
      "You trust them more than you feel close to them. Their reliability can support work, information, or a promise without creating affection or private access.",
      "They have earned confidence on practical ground, but little emotional claim. You can depend on what they do and remain personally distant.",
      "Your judgment of their reliability is better than your feeling toward them. Trust opens selected doors; warmth and intimacy stay elsewhere.",
      "They are safe to rely on in known ways and not especially close. The relationship can be solid, useful, and emotionally plain.",
      "You expect them to follow through without expecting them to understand you deeply. That distinction keeps cooperation easy and exposure limited.",
      "Confidence exists without tenderness. You may give them responsibility or believe their word while keeping your private life and emotional attention out of reach.",
    ],
  },
  {
    id: "unfamiliar-adverse",
    // Low history limits certainty. It must not flatten a severe current stance into mild caution.
    matches: (a) =>
      a.familiarity <= 0
      && (
        [a.trust, a.warmth, a.respect].some((value) => value <= -3)
        || [a.trust, a.warmth, a.respect].filter((value) => value <= -2).length >= 2
        || a.tension >= 3
      ),
    prose: [
      "You barely know them, but what little footing exists is sharply unfavorable. Distrust, aversion, low regard, or active tension makes distance a present judgment rather than a neutral lack of familiarity.",
      "There is little shared history and already a strong reason not to offer ease. The short history limits what you can claim about their whole character; it does not weaken how cold, distrustful, or tense the relationship is now.",
      "They remain largely unknown to you, yet the current relationship is not neutral. Several harsh impressions reinforce one another, so you keep them at a real distance while leaving future evidence free to change the judgment.",
      "Almost no ordinary familiarity stands between you, but the existing stance has gone well beyond simple reserve. You have little warmth or confidence to offer and no reason to disguise the force of that distance.",
      "The history is thin; the aversion is not. Strong distrust, coldness, low respect, or tension already governs access, even though you avoid pretending that a severe first judgment explains every part of the person.",
      "You do not know them well, and what you do hold is markedly bad. Their present standing calls for narrow access and little goodwill without turning uncertainty into invented crimes or permanent certainty.",
    ],
  },
  {
    id: "curious-wary",
    matches: (a) =>
      a.curiosity >= 1
      && (a.trust <= -1 || a.warmth <= -1 || a.respect <= -1 || a.tension >= 1),
    prose: [
      "You want to understand them without feeling at ease with them. Curiosity keeps attention open while caution keeps trust, goodwill, or access narrow.",
      "Something about them remains worth examining despite poor footing. Interest supports another question, not a favorable judgment.",
      "They hold your attention and your caution at once. You may test, watch, or ask directly while refusing to fill uncertainty with trust.",
      "The relationship contains a live question and a real reason for distance. Learning more matters because the answer could confirm or change the concern.",
      "You are not indifferent, and you are not reassured. Curiosity makes you stay with the uncertainty longer than comfort would explain.",
      "Their contradictions invite attention while their standing limits generosity. You can seek clarity without offering closeness in advance.",
    ],
  },
  {
    id: "unfamiliar-curious",
    matches: (a) => a.familiarity <= 0 && a.curiosity >= 1,
    prose: [
      "You do not know them well, but something about their manner has earned another look. Curiosity gives them more attention than familiarity or trust yet supports.",
      "They remain hard to read and worth observing. You may ask, test, or stay near the subject without deciding whether you like or trust the person.",
      "There is an open question where a relationship might later form. For now, interest is real and the rest of the footing is thin.",
      "Their patterns are not stable to you yet. A detail, contradiction, or unexpected choice keeps your attention without granting them closeness.",
      "You want to understand more than you currently know. That can make you direct or watchful, but it does not make a stranger familiar.",
      "They have caught your curiosity before they have earned a settled place. You leave room for discovery without filling the gaps with trust, warmth, or suspicion.",
    ],
  },
  {
    id: "unfamiliar-wary",
    matches: (a) => a.familiarity <= 0 && (a.trust <= -1 || a.warmth <= -1 || a.respect <= -1 || a.tension >= 1),
    prose: [
      "You do not know them well enough to soften the concern into a familiar explanation. Their current conduct gives you reason for caution, but not a complete theory of who they are.",
      "The footing is thin and already uncomfortable. You keep access narrow while leaving room for later evidence to confirm or change the first judgment.",
      "They are unfamiliar and presently difficult to trust or like. You respond to what is concrete without turning uncertainty into a larger invented threat.",
      "Little shared history exists to interpret their manner generously. Caution is appropriate, but each new act still has to earn its own meaning.",
      "Your first stable impression is wary rather than warm, so ease may remain limited. You also do not know enough to make every ambiguity hostile.",
      "Distance comes from both limited knowledge and an unfavorable signal. You watch what follows before deciding whether the problem is a pattern or only one encounter.",
    ],
  },
  {
    id: "uncertain-interest",
    matches: (a) => a.curiosity >= 1 && (a.attraction >= 0 || a.familiarity >= 0),
    prose: [
      "Something about them keeps catching your attention, but the pull has not settled into one clear feeling. You give the connection some room without treating it as trust, intimacy, or commitment.",
      "Interest is present in several small forms and decisive in none. Familiarity, curiosity, or attraction may be beginning to gather, but you do not yet know what you want from it.",
      "They are becoming more personally noticeable without becoming important. You may test the rhythm, remember a detail, or return to a question while leaving the relationship unnamed.",
      "There is enough here to make the next exchange matter slightly more than the last. The interest remains provisional and does not need to become affection or desire.",
      "Your attention has started to distinguish them from the room. What that distinction means is still open, so you neither dismiss it nor promote it into a bond.",
      "A mild pull toward understanding, recognition, or attraction remains unresolved. You let current conduct shape it instead of deciding early what kind of relationship this must become.",
    ],
  },
  {
    id: "warm-distant",
    matches: (a) =>
      a.warmth >= 1
      && a.trust <= 0
      && a.respect <= 0
      && a.curiosity <= 0
      && a.attraction <= 0
      && a.intimacy <= 0
      && a.attachment <= 0
      && a.tension <= 0,
    prose: [
      "You like them without feeling especially close, reliant, or invested. Warmth improves ordinary contact while the rest of the relationship remains light.",
      "Their company is pleasant to you, but it carries little private access or emotional claim. Fondness can remain simple.",
      "You meet them with genuine goodwill without treating them as trusted or important. The favorable feeling is real and limited.",
      "They receive more patience and ease than a neutral acquaintance, while dependence, disclosure, and future weight remain ordinary.",
      "There is uncomplicated liking here. You can enjoy the person without seeking a deeper bond or inventing confidence that has not formed.",
      "Warmth colors the exchange without organizing your life around them. Their presence can feel good and their absence can remain easy.",
    ],
  },
  {
    id: "respected-distant",
    matches: (a) =>
      a.respect >= 1
      && a.trust <= 0
      && a.warmth <= 0
      && a.curiosity <= 0
      && a.attraction <= 0
      && a.intimacy <= 0
      && a.attachment <= 0
      && a.tension <= 0,
    prose: [
      "You hold them in real regard without feeling warm, close, or dependent. Their ability or judgment matters more than their company.",
      "They have earned serious attention, but not personal access. Respect can remain formal, practical, or distant without becoming affection.",
      "You value something substantial in them while keeping the relationship emotionally plain. Their words carry weight where their company does not.",
      "They are worth listening to without becoming someone you seek for comfort or closeness. Regard and distance coexist easily.",
      "You grant credit, status, or careful consideration on its merits. Nothing in that respect requires warmth, trust, or attachment.",
      "Their competence or principle has a place in your judgment, while their presence has little claim on your private attention.",
    ],
  },
  {
    id: "open-detached",
    matches: (a) =>
      a.intimacy >= 1
      && a.trust <= 0
      && a.warmth <= 0
      && a.respect <= 0
      && a.curiosity <= 0
      && a.attraction <= 0
      && a.attachment <= 0
      && a.tension <= 0,
    prose: [
      "You permit some personal openness without feeling a larger bond around it. Access can be chosen and real while warmth, trust, attraction, and importance remain limited.",
      "They can reach a private part of you without becoming central. Disclosure or physical ease does not require attachment.",
      "You are comfortable with selected exposure and emotionally uncommitted beyond it. The open door is specific, not a promise of closeness everywhere.",
      "Personal access has developed ahead of fondness or dependence. You can share honestly while keeping the rest of the relationship light.",
      "They receive more openness than an ordinary acquaintance. Selected openness does not imply broader access; intimacy remains its own dimension.",
      "You can let them near without needing them to stay. The comfort is genuine, bounded, and free of invented emotional weight.",
    ],
  },
  {
    id: "growing-positive",
    matches: (a) => a.trust >= 1 || a.warmth >= 1 || a.respect >= 1 || a.intimacy >= 1 || a.attachment >= 1,
    prose: [
      "Several parts of the relationship have begun to lean positive without forming a complete bond. You give the person the specific trust, warmth, regard, or access they have earned and leave the other dimensions open.",
      "There is real favorable footing here, but it is selective. One good dimension can shape your next choice without borrowing strength from feelings that have not developed.",
      "The relationship has moved beyond neutrality in a few grounded ways. You can offer more ease, confidence, or attention while keeping the unsupported parts ordinary.",
      "Something durable and positive has formed, though it remains incomplete. The person receives the benefit of what exists rather than a performance of closeness as a whole.",
      "You hold a better private stance toward them than you once did. It may appear through patience, regard, access, or effort without requiring affection or intimacy to match.",
      "The connection has acquired some positive weight. You let that matter where it is relevant and do not turn it into trust, desire, or attachment by implication.",
    ],
  },
  {
    id: "familiar-neutral",
    matches: (a) => a.familiarity >= 1,
    prose: [
      "You know their ordinary manner better than your feelings about them suggest. Their habits and likely intent are easier to place, while warmth, trust, and personal importance remain limited.",
      "They are familiar without being close. You can recognize their jokes, pauses, confidence, weakness, and changes of pace without granting them special access.",
      "Shared contact has made them predictable in useful ways. The knowledge supports smoother conversation, not affection or obligation.",
      "You have enough history to read much of their range without much uncertainty. Whether you enjoy that range is a separate question with no strong answer yet.",
      "Their way of speaking and reacting is known to you. Familiarity may support teasing or patience, but it does not by itself make the relationship warm.",
      "You no longer meet them as a stranger, and little else is settled. Recognition is durable; closeness, trust, and desire still need their own evidence.",
    ],
  },
  {
    id: "unknown-neutral",
    matches: () => true,
    prose: [
      "There is little durable relationship state here yet. Treat the present exchange on its own evidence without inventing closeness, hostility, trust, or suspicion.",
      "This person has not earned a strong private stance in either direction. Ordinary contact can remain ordinary while later patterns establish what matters.",
      "The relationship is still mostly open ground. You know too little to presume affection or threat, and nothing requires a visible performance of neutrality.",
      "No clear bond or durable conflict defines this person yet. Let concrete conduct carry more weight than imagined history.",
      "They remain a stranger or distant acquaintance in relationship terms. You can be interested, helpful, curt, amused, or silent for present reasons without making it a lasting stance.",
      "Very little has settled between you. The absence of stored feeling is not dislike, trust, warmth, or an invitation to manufacture any of them.",
    ],
  },
] as const;

interface AxisBandThresholds {
  mild: number;
  positive: number;
  strong: number;
}

// Easily accumulated axes need more absolute weight; quieter axes should register earlier.
const AXIS_BAND_THRESHOLDS = {
  familiarity: { mild: 10, positive: 40, strong: 75 },
  trust: { mild: 5, positive: 20, strong: 50 },
  warmth: { mild: 10, positive: 35, strong: 65 },
  respect: { mild: 8, positive: 30, strong: 60 },
  tension: { mild: 8, positive: 30, strong: 60 },
  curiosity: { mild: 6, positive: 25, strong: 55 },
  attraction: { mild: 3, positive: 15, strong: 40 },
  intimacy: { mild: 8, positive: 25, strong: 55 },
  attachment: { mild: 5, positive: 20, strong: 50 },
} as const satisfies Record<RelationshipAxis, AxisBandThresholds>;

function axisBand(axis: RelationshipAxis, value: number): AxisBand {
  const thresholds = AXIS_BAND_THRESHOLDS[axis];
  const magnitude = Math.abs(value);
  const level = magnitude >= thresholds.strong
    ? 3
    : magnitude >= thresholds.positive
      ? 2
      : magnitude >= thresholds.mild
        ? 1
        : 0;
  if (level === 0) return "neutral";
  if (value > 0) {
    return level === 3 ? "strong-positive" : level === 2 ? "positive" : "mild-positive";
  }
  return level === 3 ? "strong-negative" : level === 2 ? "negative" : "mild-negative";
}

const BAND_NUMBER: Record<AxisBand, number> = {
  "strong-negative": -3,
  negative: -2,
  "mild-negative": -1,
  neutral: 0,
  "mild-positive": 1,
  positive: 2,
  "strong-positive": 3,
};

function bandVector(axes: RelationshipAxes): BandVector {
  return Object.fromEntries(
    RELATIONSHIP_AXES.map((axis) => [axis, BAND_NUMBER[axisBand(axis, axes[axis])]]),
  ) as BandVector;
}

function shadeIndex(axes: RelationshipAxes): number {
  const signature = RELATIONSHIP_AXES.map((axis) => axisBand(axis, axes[axis])).join("|");
  let hash = 2166136261;
  for (const character of signature) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 6;
}

/** Select one stable whole-relationship portrait from all nine axis bands. */
export function relationshipPortrait(axes: RelationshipAxes): RelationshipPortrait {
  const bands = bandVector(axes);
  const family = PORTRAIT_FAMILIES.find((candidate) => candidate.matches(bands));
  if (family === undefined) throw new Error("Relationship portrait fallback is missing.");
  const shade = shadeIndex(axes);
  const opener = family.prose[shade];
  const expansion = RELATIONSHIP_PORTRAIT_EXPANSIONS[family.id];
  if (expansion === undefined) {
    throw new Error(`Relationship portrait expansion ${family.id} is missing.`);
  }
  const detail = expansion.shades[shade];
  if (opener === undefined || detail === undefined) {
    throw new Error(`Relationship portrait shade ${shade} is missing.`);
  }
  // Compact contexts retain the combined interpretation. The final shade is reserved for full profiles.
  const compactProse = `${opener} ${expansion.core}`;
  return {
    id: `${family.id}-${shade + 1}`,
    compactProse,
    prose: `${compactProse} ${detail}`,
  };
}

/** List every stable portrait ID for validation and management views. */
export function relationshipPortraitVariantIds(): string[] {
  return PORTRAIT_FAMILIES.flatMap((family) =>
    family.prose.map((_prose, index) => `${family.id}-${index + 1}`)
  );
}
