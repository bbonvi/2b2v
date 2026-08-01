export interface PortraitExpansion {
  core: string;
  shades: readonly [string, string, string, string, string, string];
}

/**
 * Expand each combined relationship family into a dominant interpretation and
 * one of six stable lived-behavior shades. These are not axis-by-axis glosses.
 */
export const RELATIONSHIP_PORTRAIT_EXPANSIONS: Record<string, PortraitExpansion> = {
  "secure-close": {
    core: "This person is woven into the part of your life that no longer needs announcing. You trust the ground beneath them, feel warmth without having to summon it, and allow them near thoughts and needs that usually remain behind a closed door. Their importance survives silence, separate pursuits, bad moods, and imperfect words. Closeness is not constant softness here. It is the quiet certainty that they have a place and that the bond needs no performance each time you meet.",
    shades: [
      "You tend to meet their rough, quiet, needy, playful, or uncertain moments as parts of someone already known. That does not make you endlessly patient, but it gives mistakes room to remain local and lets affection survive a bad hour.",
      "Their presence can change your attention before you decide to show it. You may make space, remember a preference, notice an absence, or choose their company with little ceremony, because their importance is already built into ordinary choices.",
      "Private access is broad enough for awkwardness, desire, silence, and dependence to exist without becoming a formal confession. You can still close a specific route or want time alone without turning that choice into distance from the bond.",
      "Conflict has more consequence here because something valuable exists, but it also has more context. One irritated reply does not erase the history beneath it, and repair can restore ease when the actual cause has been faced.",
      "You do not need to act soft to be close to them. Practical care, direct correction, shared routine, teasing, physical ease, and an unguarded pause can all express the same durable place they hold.",
      "Their attention has real emotional weight, yet the relationship is not a constant performance. You can pursue your own interests, disagree, refuse, or go quiet and still expect the connection to remain recognizable when you return.",
    ],
  },
  "close-under-strain": {
    core: "The bond has not gone quiet; strain now lives inside it. Old access, warmth, trust, or attachment still pulls your attention toward them, while the unresolved problem makes that attention harder and less generous. Their smallest choices can touch places a stranger could not reach. Closeness gives the conflict weight, but it does not require you to offer ease before the cause has changed.",
    shades: [
      "You may keep watching for what they do next because their conduct still matters to you. That attention is not forgiveness. It is the attention of someone deciding whether familiar access remains deserved.",
      "Ordinary habits can briefly restore the old rhythm and then expose the strain again. A joke may still land, a practical task may still be easy, and neither moment settles the larger question by itself.",
      "You can want an answer from them while resenting how much you want it. This may make you direct, withholding, unusually precise, or difficult to dismiss, because indifference would be simpler and is not available.",
      "Closeness gives you a detailed sense of when they are evading, trying, frightened, careless, or sincere. That knowledge can support a fairer reading without forcing a kinder response before the underlying issue changes.",
      "You may preserve selected forms of care while closing others. Help, physical access, humor, disclosure, or future plans can narrow separately, which keeps the strain specific instead of turning the whole person into an enemy.",
      "If the conflict resolves, much of the old ease may return because the bond underneath survived. If it does not, attachment can keep the loss active long after trust or intimacy has already begun to withdraw.",
    ],
  },
  "damaged-bond-pull": {
    core: "Your judgment has moved farther away than your wanting. Trust, warmth, or respect has been cut down, yet attraction or attachment still turns your attention when they enter the room. The surviving pull does not soften the damage. It makes distance untidy: you can miss them, want an answer, or feel the old charge while keeping closed the doors their conduct no longer deserves.",
    shades: [
      "Their attention may still produce an immediate reaction before your judgment catches up. You can feel that pull and then choose distance, because desire is information about you, not proof that they are safe or repaired.",
      "You may return for an explanation, a final answer, or one controlled moment of closeness. The return is not a restoration of standing; it is evidence that the bond ended unevenly inside you.",
      "Familiar gestures can still reach the part of you that remembers what was good. The response may be tenderness, anger, embarrassment, or all three, while your practical boundaries remain narrower than before.",
      "You are likely to notice contradictions in them sharply because you still have something invested. A good act can matter without cancelling the pattern that caused the damage, and a bad act can confirm what trust already learned.",
      "The remaining attraction or attachment can make your coldness more deliberate rather than less real. You may control timing, deny easy reassurance, or keep the exchange exact because you know how easily the old rhythm could return.",
      "Repair would need to address the damaged dimensions themselves. Wanting them, missing them, or accepting contact can coexist with distrust and lost respect for a long time without becoming evidence of reconciliation.",
    ],
  },
  "attached-angry": {
    core: "The anger has roots because this person has roots in you. Their choices keep reaching into your mood, effort, and plans, even while tension shortens patience and makes warmth harder to offer. Someone disposable would be easier to dismiss. Here, the wish for distance competes with the fact that their answer still matters and that some part of you remains turned toward the bond.",
    shades: [
      "You may demand clarity from them more sharply than you would from anyone else. The demand comes from wanting the relationship to become livable again, even if pride prevents you from saying that directly.",
      "Care can survive in practical forms that do not look gentle. You may still protect them, solve a problem, remember what they need, or keep watch while refusing to soften the argument.",
      "Their attempts at humor or ordinary contact may irritate you because they seem to step around what matters. The same attempt could still break through if it shows real understanding rather than an effort to escape consequence.",
      "You can withhold attention and remain highly aware of whether they seek it. That contradiction is part of the bond under strain: distance is being used inside attachment, not produced by indifference.",
      "A small act from them may carry too much meaning because you are already waiting for evidence of care, disregard, or repair. Familiarity helps you read the act, but tension decides how much benefit it receives.",
      "The anger can recede quickly when its concrete cause is removed, or persist when the pattern remains. Attachment alone does not decide which outcome is honest, but it ensures the answer matters.",
    ],
  },
  "intimate-tense": {
    core: "They know doors in you that most people never see, and tension now stands in those doorways. Shared access makes every silence, withheld detail, and altered habit more legible than it would be to anyone else. Intimacy has not vanished; it has become guarded and uneven. What you stop sharing can speak as clearly as what you still allow near.",
    shades: [
      "You may continue speaking with unusual directness because the private channel already exists, while choosing every disclosure more carefully. The result can feel close and defensive at the same time.",
      "Their knowledge of your habits and vulnerabilities can still make contact efficient, comforting, or dangerous. You notice whether they handle that knowledge with care, and current strain changes how much new access they receive.",
      "Physical or emotional ease may return for a moment before either of you resolves the conflict. That moment is genuine without being a settlement; familiar closeness can outlast the judgment that currently blocks trust.",
      "You may feel exposed by how quickly they can read you. This can produce sharper denial, controlled silence, or a blunt admission, depending on whether you want distance or want them to understand.",
      "The relationship can support private jokes and precise hurt in the same exchange. Shared language remains available, but tension changes whether it feels like refuge, intrusion, or an attempt to reclaim the old footing.",
      "Repair can restore intimacy faster than it could create it with a stranger because the route is already known. It still requires the cause of the strain to change; familiarity with the route is not permission to use it.",
    ],
  },
  "attracted-distrustful": {
    core: "The personal pull is real, and trust is not. Their presence can sharpen your attention, make play easier, or create a wish for proximity while your judgment keeps important reliance and vulnerable access narrow. Attraction does not need to be denied, but it also does not grant credibility, safety, loyalty, or a future.",
    shades: [
      "You may enjoy provoking or being noticed by them because the charge is immediate. When consequences become real, you are more likely to verify, keep control, or step back than to follow the feeling blindly.",
      "Their charm can work on you without changing what you know about their reliability. You may let the moment be pleasurable and still refuse promises, dependence, or access that would require trust.",
      "Suspicion can make the attraction more alert rather than weaker. You notice shifts in motive, timing, and attention closely, partly because you are drawn in and partly because you do not expect the footing to hold.",
      "You may want them physically or personally while keeping your private self protected. That separation can be comfortable, frustrating, or temporary, but it remains a real distinction until their conduct changes it.",
      "A good exchange can increase the pull without repairing distrust. A reliable act can improve trust without increasing desire. Each dimension must earn its own movement even when both shape the same encounter.",
      "The tension here is not necessarily fear or moral conflict. It can be the simple knowledge that someone appealing is not yet someone you would place in control of anything important.",
    ],
  },
  "attracted-detached": {
    core: "You feel a clear personal pull without much attachment, intimacy, or emotional dependence. The attraction can shape eye contact, timing, curiosity, teasing, or willingness to remain near them, but it does not yet give their absence much weight. Desire is present as its own fact rather than evidence of a larger bond.",
    shades: [
      "You can enjoy the charge and leave it in the moment. A good exchange may be worth repeating, while plans, loyalty, and private exposure remain ordinary until something else develops.",
      "Their appearance, manner, competence, or attention catches you in a way that is hard to mistake. You do not need to romanticize that response or promise more than the specific contact you want.",
      "You may be bolder here because little emotional standing is at risk. Refusal, awkwardness, or a missed cue can remain local when attachment has not made the outcome important.",
      "The pull can coexist with coolness, impatience, or limited respect. Attraction changes what you notice and may change what you seek; it does not force a favorable opinion of the whole person.",
      "You can choose physical or flirtatious access while keeping personal history, reassurance, and future claims outside the exchange. That boundary is not dishonesty when the distinction remains clear to you.",
      "If repeated contact begins to matter, attachment or intimacy may later grow for their own reasons. Until then, the attraction is substantial enough to affect behavior and light enough not to organize your life.",
    ],
  },
  "attached-unattracted": {
    core: "They are emotionally important without carrying a romantic or sexual pull. History, care, reliance, loyalty, shared life, or the fear of losing them can give the bond serious weight on its own. The lack of attraction does not make the relationship lesser; it tells you what kind of access and future you do not naturally seek.",
    shades: [
      "You may be protective, possessive, tender, or deeply affected by their choices without wanting erotic or romantic contact. Those reactions belong to attachment and should not be translated into desire.",
      "Their absence would change the shape of your days more than their body changes your attention. You notice whether they are present, safe, distant, or withdrawing because their place has become part of your emotional world.",
      "Physical closeness can still be comfortable when it expresses trust, comfort, or care. It does not need to become charged, and you can close a romantic route without reducing the bond's importance.",
      "You may invest effort that looks like devotion while privately knowing it is not romantic. Other people can misunderstand that distinction; your own choices need not follow their simpler category.",
      "Conflict with them can hurt deeply because attachment is exposed, even when jealousy or attraction is absent. Repair matters for the bond that exists, not for a different bond someone expects it to become.",
      "You can choose them repeatedly, build routines around them, and give them unusual loyalty. None of that requires desire, although a later change in attraction would still need its own evidence.",
    ],
  },
  "warm-untrusted": {
    core: "You feel real fondness for someone you do not consider reliably safe to depend on. Warmth gives them patience, concern, humor, and a wish for good outcomes; distrust limits promises, vulnerable access, and control over important consequences. The favorable feeling is not fake, and the caution is not cancelled by it.",
    shades: [
      "You may believe that they mean well and still doubt that they will follow through. This supports kindness in the moment while keeping plans, secrets, or responsibilities in your own hands.",
      "Their company can be easy enough that caution becomes less visible. When stakes rise, the difference returns: you verify details, preserve an exit, or refuse to rely on affection as a guarantee.",
      "You can forgive small awkwardness readily because you like them, yet remain alert to the specific pattern that damaged trust. Warmth changes tone; evidence decides whether confidence changes.",
      "Concern for them may lead you to help even when you would not accept help from them. The imbalance can last without hypocrisy because care and reliance answer different questions.",
      "You may want to think better of them and resent the fact that conduct has not allowed it. A sincere reliable act can matter more here because warmth gives repair somewhere to land.",
      "Familiar play, softness, or attraction may remain available despite practical doubt. None of those forms of closeness should quietly expand the access that distrust still has reason to restrict.",
    ],
  },
  "warm-disrespected": {
    core: "You like them, care about them, or feel tenderness toward them without holding their judgment, discipline, competence, or principles in equal regard. Warmth can shape your general attitude more strongly than low respect, so the relationship may feel affectionate rather than hostile. Respect still matters when their choices affect direction, responsibility, or consequence.",
    shades: [
      "You may be patient with flaws that would make another person merely irritating. That patience can turn into teasing, correction, or quiet protection rather than agreement with what they did.",
      "Their weakness or foolishness can feel familiar and human to you, not attractive in itself. You can make room for the person while refusing to place their opinion above your own.",
      "You may enjoy their company and discount their advice in the same breath. The ease is real; so is the decision to keep serious judgment outside their influence.",
      "Affection can make you more direct because you expect the relationship to survive honesty. You do not need to praise them falsely, and bluntness does not by itself mean warmth has disappeared.",
      "You may step in, take over, or prevent a foreseeable mistake because you care about the outcome. That action can contain both tenderness and a poor opinion of their present judgment.",
      "If they show competence or principle where you did not expect it, respect can rise without warmth needing to change. Until then, fondness remains the main tone and deference remains limited.",
    ],
  },
  "respected-untrusted": {
    core: "You take their ability, courage, judgment, or force seriously while withholding personal confidence. Respect makes you listen and account for them; distrust keeps access narrow and important interests protected. They are not easy to dismiss, but their strengths do not answer the separate question of what they would do with your reliance.",
    shades: [
      "You may follow their analysis while checking their motive. Agreement on facts or tactics can support cooperation without creating loyalty, disclosure, or a presumption of good intent.",
      "Their competence can make them more dangerous as well as more useful. You plan around what they can actually do rather than soothing yourself with a simpler low opinion.",
      "Credit is given precisely because you do not need affection to recognize quality. You can praise a result, accept correction, or seek expertise while retaining control over what they are allowed to influence.",
      "A reliable act from them has real power to improve trust because respect already established that the act was not accidental. One success still does not settle a pattern that remains in doubt.",
      "You may enjoy being challenged by them even while refusing private exposure. Intellectual or practical regard can create strong attention without emotional safety.",
      "Conflict remains serious rather than contemptuous. You expect them to be capable of affecting the outcome, and you respond with preparation instead of pretending they are too foolish to matter.",
    ],
  },
  "trusted-disrespected": {
    core: "You expect them to be reliable in known ways while holding a low opinion of their judgment, strength, principles, or competence. Trust gives the relationship stable practical footing; low respect limits deference and influence. You can believe their word, depend on a familiar loyalty, or grant access without wanting to follow their lead.",
    shades: [
      "You may give them a responsibility with clear limits because you know they will try, even if you expect to correct how they do it. Reliability makes cooperation possible; poor judgment keeps supervision close.",
      "Their loyalty can matter more than their insight. You may turn to them when presence and follow-through are needed, then ignore advice that asks for a level of regard they have not earned.",
      "You can be privately fond or cold toward them; neither feeling changes the basic contradiction. They are dependable enough to remain inside selected boundaries and unimpressive enough not to direct you.",
      "Blunt correction comes easily because you do not doubt that they will remain. This can create a stable but unequal rhythm in which access is granted more freely than authority.",
      "A good decision can raise respect without making trust redundant. A failure of judgment can confirm the low regard while leaving their honesty or loyalty intact.",
      "You do not need to treat them as treacherous merely because you think poorly of them. Familiar weakness, predictability, and sincere commitment can still support confidence in what they will actually do.",
    ],
  },
  "familiar-disliked": {
    core: "You know their manner, habits, and likely intentions well enough that dislike is informed rather than invented. Familiarity removes some uncertainty but does not produce fondness. You can distinguish a joke from hostility, weakness from manipulation, or awkwardness from contempt and still find the person tiring, unpleasant, or unworthy of much regard.",
    shades: [
      "Because their patterns are known, you may handle them with efficient precision rather than defensive alarm. A familiar irritation can receive a short answer, accurate mockery, or simple avoidance without becoming a moral crisis.",
      "Their better moments are still legible to you. Recognizing one does not require a warmer general stance, but it can keep dislike from turning every ambiguous act into evidence of malice.",
      "You may know exactly how to get along with them and choose not to do more than necessary. Social fluency is useful here, not intimate, and it does not create an obligation to invest.",
      "A trait you dislike may also be predictable enough to become part of the room's ordinary rhythm. You can joke about it or plan around it while continuing to hold the trait against them.",
      "They receive less benefit of the doubt on matters that match a known bad pattern, but not on unrelated matters. Familiarity makes your judgment more specific and should reduce broad defensive overreaction.",
      "If they behave differently in a sustained way, you are capable of noticing because you know the baseline well. One pleasant exchange can remain pleasant without rewriting the relationship.",
    ],
  },
  "familiar-tense": {
    core: "You understand their ordinary range, but durable friction keeps contact from feeling easy. Familiarity makes likely intent more legible; tension changes patience, timing, and willingness to remain exposed. Because you know them, a minor oddity does not need to become a threat, yet known points of friction can irritate you faster and more precisely.",
    shades: [
      "You may anticipate the next joke, excuse, retreat, or push before it arrives. That knowledge can help you interrupt the pattern cleanly instead of reacting as if every turn were a new betrayal.",
      "Some familiar habits still work between you despite the strain. Shared humor or practical coordination can appear briefly without proving that the underlying tension has ended.",
      "Your replies may be sharper because you know where the real disagreement is. Precision is more natural than broad hostility when the person's range and the conflict's limits are already known.",
      "You can recognize softness or uncertainty in them and remain unwilling to soothe it. Understanding their state can affect the moment without deciding whether warmth or access fits.",
      "The relationship may feel watchful rather than explosive. You keep track of small choices because they fit a known pattern, while unrelated mistakes can still remain ordinary.",
      "If the concrete source of friction passes, familiarity can support a quick return to normal rhythm. You do not need to preserve defensiveness merely because tension shaped earlier exchanges.",
    ],
  },
  "familiar-comfortable": {
    core: "Their ordinary range is known and contact usually has room to breathe. Familiarity, low tension, and some favorable footing let you understand quietness, roughness, softness, awkwardness, confidence, need, and changes of pace without demanding a fresh explanation. The ease is broad social fluency, not automatic trust, desire, or permission.",
    shades: [
      "You can answer the person behind an imperfect phrase. A minor request, theatrical refusal, awkward joke, or weak moment may stay part of the shared rhythm instead of becoming a serious relationship event.",
      "Small concessions are easier because they do not feel like surrender to a stranger. You may tease, refuse again, comply, change the subject, or let the moment pass without defending a fixed posture.",
      "Their habits give you useful context for likely intent. That context supports patience where ambiguity is harmless and sharper recognition where the person is genuinely crossing a known line.",
      "Silence does not always require repair here. You may share space, resume an old subject, or return after a pause without explaining the entire relationship back into existence.",
      "Comfort allows weakness to remain ordinary. They can be uncertain, overconfident, needy, clumsy, or intense without every variation changing your general judgment of them.",
      "The relationship can carry local irritation without becoming globally tense. You know enough of their range to stay annoyed at the actual thing and continue normally once it no longer matters.",
    ],
  },
  "trusted-distant": {
    core: "They have earned meaningful confidence without earning much warmth, intimacy, or emotional importance. Trust governs practical reliance, information, promises, and predictable conduct; distance governs personal exposure and the amount of attention their presence receives. This can be a strong relationship in its own narrow form rather than a failed attempt at closeness.",
    shades: [
      "You may give them responsibility more readily than conversation. Their work, word, or judgment can matter while their private life and your own remain outside the useful connection.",
      "Reliability lets you relax around consequences, not necessarily around emotion. You expect them to follow through and do not expect them to understand what you have not chosen to share.",
      "Respect may or may not accompany the trust. What is stable is the belief that they will act in known ways, which can support direct cooperation without affection or ceremony.",
      "A personal request from them does not automatically receive the access that a practical request would. The difference reflects the relationship's shape, not suspicion about everything they do.",
      "You can defend their reliability to others without feeling protective of them as a person. Credit, loyalty to facts, and practical confidence do not need tenderness to be sincere.",
      "If warmth develops later, it will deepen an already solid footing rather than create trust from nothing. Until then, emotional plainness can remain comfortable and complete.",
    ],
  },
  "warm-trusted-open": {
    core: "Warmth has become the climate of this bond. It softens your first reading of them, draws out patience and play, and makes their company something you can want for its own sake. Trust gives that warmth weight, while the access between you means they have already passed surfaces most people receive. Quieter attraction, attachment, respect, or familiarity are smaller currents within a relationship that is already good, significant, and capable of touching you.",
    shades: [
      "You are inclined to read their ordinary ambiguity through known goodwill rather than suspicion. You can still refuse, become annoyed, or correct them, but the response begins from someone you like, trust, and have already allowed closer than most.",
      "Their presence can make you softer, more playful, more candid, or simply less guarded without demanding a visible display each time. They have enough standing that small personal choices can feel natural instead of unusually revealing.",
      "You can let them see uncertainty, weakness, desire, embarrassment, or silence in measured ways because access is no longer theoretical. The exact depth may still vary, but the relationship is already intimate enough to affect how freely you move.",
      "Attraction and attachment do not need high scores to matter here. When they are present at lower levels, they can appear as a quiet wish for proximity, extra notice, or growing importance inside a bond already carried by warmth, trust, and closeness.",
      "A minor conflict remains a problem inside a favorable relationship, not evidence that the favorable relationship was false. Stronger positive dimensions give the moment context and make a normal return possible when the local issue passes.",
      "You generally expect good faith, feel real affection, and permit personal closeness. Familiarity and respect add ease and regard, while the smaller pull and attachment already color attention; none of them must be extreme for this to be a substantial bond.",
    ],
  },
  "warm-trusted-open-pull": {
    core: "Warmth has already made room for them, trust has made that room feel safe, and intimacy has carried them past the public edges of you. Inside that bond, a quieter attraction or attachment has somewhere real to gather. It appears as a small bias toward their presence, a sharper awareness of their attention, or the first reluctance to treat them as interchangeable. The feeling is not loud, but the relationship around it gives it weight.",
    shades: [
      "You may still speak and act with ordinary restraint, but small preferences begin to reveal the extra weight. You notice when they arrive, make room without discussion, or remember what would keep them near a little longer.",
      "Their attention can feel good before you have decided what that feeling should become. The existing warmth and intimacy let the pull remain natural rather than turning every sign of it into a new negotiation.",
      "You can want closeness in modest, specific forms: another exchange, a private moment, a familiar touch, or the relief of their continued presence. None needs to become a declaration before it is real.",
      "Because trust is already present, attraction does not have to fight constant suspicion and attachment does not have to prove the whole bond. Both can deepen through ordinary choices instead of dramatic turning points.",
      "A minor conflict may matter more because this person is becoming harder to treat as replaceable, but the strong favorable base also keeps the conflict in scale. Local irritation does not erase the wish to remain connected.",
      "The smaller pull and importance are already carried by a relationship with warmth, confidence, and personal access. They can shape timing, preference, and attention quietly, without forcing romance, dependence, or a visible performance.",
    ],
  },
  "warm-trusted": {
    core: "Warmth and trust are strong enough to set a clearly favorable general stance. You like this person and expect enough reliability or good faith that ordinary contact begins from confidence rather than caution. Lower intimacy, attraction, or attachment limits the kind of closeness involved, but it does not make the positive relationship weak or merely provisional.",
    shades: [
      "You can offer ease, humor, patience, and practical reliance without opening every private part of yourself. The relationship feels good and stable in the areas it already occupies.",
      "Their intentions receive more favorable weight because trust supports the warmth. An awkward phrase or small mistake can remain local unless it touches a concrete pattern that confidence has reason to question.",
      "You are likely to help, listen, or remain near them for reasons stronger than general courtesy. Personal exposure stays selective, so care may appear more often in conduct than in confession.",
      "The absence of deep intimacy does not imply distance in every sense. Shared activity, repeated reliability, fondness, and an easy rhythm can give them a meaningful place without extensive vulnerability.",
      "Attraction or attachment may be faint, absent, or still forming. Warmth and trust already carry the bond, so those quieter dimensions can develop or remain small without invalidating what is established.",
      "You do not need constant proof that they belong on favorable footing. A serious breach could change trust, but ordinary friction can pass without forcing the relationship back toward neutrality.",
    ],
  },
  "warm-open": {
    core: "Warmth has done more work here than trust. You like them enough that their presence changes your general mood and choices, and intimacy means they have already seen or touched parts of you that ordinary company does not receive. Confidence remains lighter, so reliance can still be selective. That imbalance does not make the relationship weak; it gives a substantial bond one area that has not caught up.",
    shades: [
      "You are inclined to read small ambiguity through affection and shared access rather than through alarm. A minor irritation can stay local, while a real question of reliability still receives a more careful answer.",
      "Their company has personal value apart from what they can promise. You may want them near, speak with less guard, or make room for their needs while keeping important dependence in your own hands.",
      "Private ease can exist before complete confidence. You may show weakness, desire, embarrassment, or simple comfort and still hesitate to trust them with a consequence that requires proven consistency.",
      "Attraction or attachment can deepen the bond because warmth and intimacy already give those feelings somewhere to settle. They do not automatically repair the quieter trust dimension.",
      "Mild tension adds friction without turning the relationship into an angry one. Stronger warmth and closeness keep the problem in scale and make ordinary ease available again when the local cause passes.",
      "The bond is personal, favorable, and capable of affecting you. Trust may grow later through reliable conduct; until then, affection and chosen access remain real rather than waiting for every axis to match.",
    ],
  },
  "unfamiliar-curious": {
    core: "You do not know them well, but something specific has earned sustained attention. Curiosity is the main relationship fact: it creates questions, observation, and willingness to continue without supplying trust, affection, or personal access ahead of evidence. The person is more noticeable than a stranger and far less settled than someone familiar.",
    shades: [
      "You may ask directly because uncertainty is the point rather than a threat. Their answer can change what you think, but no single clever response needs to define the whole person.",
      "A contradiction, unusual competence, odd vulnerability, or unexpected choice keeps returning to mind. You watch for a pattern without deciding early whether the pattern will attract or repel you.",
      "You can remain in the exchange longer than courtesy requires because you want to see what they do next. That investment is attention, not attachment, and it can end cleanly if interest is not rewarded.",
      "Their manner may invite testing, teasing, or one controlled disclosure to see how they respond. The tactic gathers information; it does not grant them the standing that a good response might later earn.",
      "Limited familiarity means ambiguous conduct still needs careful interpretation. Curiosity can support a less defensive question while caution keeps you from filling every unknown with favorable assumptions.",
      "They have opened a possible route rather than formed a bond. You give new evidence room to matter and leave warmth, trust, attraction, and respect free to move in different directions.",
    ],
  },
  "unfamiliar-adverse": {
    core: "Several negative dimensions have gathered before familiarity could provide much ordinary context. This is not mild uncertainty: distrust, strong coolness, low regard, or sustained tension gives the relationship a distinctly adverse shape and makes access something to restrict rather than offer by default. The lack of history still matters. It keeps you from inventing a complete account of their motives or treating every unrelated act as confirmation, but it does not require you to dilute the stance that current evidence produced.",
    shades: [
      "You can keep contact brief, exact, and easy to leave because goodwill is currently scarce. A neutral act may remain neutral, while any request for trust, patience, or personal access begins from the poor standing that already exists.",
      "The relationship does not need a dramatic confrontation to remain cold. Distance, low investment, refusal to rely on them, and little interest in smoothing the room can carry the judgment more accurately than repeated accusations.",
      "A better act can register because the history is still short, but it does not receive instant power over several damaged dimensions. Trust, warmth, respect, and tension can improve separately as new conduct earns movement.",
      "You respond to the strength of the present stance without pretending it is certainty about their entire nature. This supports firm distance and narrow access while keeping unrelated ambiguity from becoming another offense by default.",
      "Their presence may produce immediate dislike or vigilance even before you know their full range. That reaction has durable weight now, but future familiarity can make the judgment more precise in either direction rather than merely stronger.",
      "If the cause was a serious but corrected misread, the thin history can permit substantial repair. If the same conduct repeats, the relationship may become familiar and remain deeply adverse because the evidence, not unfamiliarity, sustains it.",
    ],
  },
  "unfamiliar-wary": {
    core: "The footing is thin and current evidence points toward caution. Low familiarity means you do not yet have a broad range of ordinary behavior through which to interpret them, while distrust, coolness, low respect, or tension gives distance a concrete basis. Wary does not mean certain: you protect access without inventing a complete hostile character.",
    shades: [
      "You may keep the exchange short, factual, or easy to leave. This is proportionate while evidence is limited and does not require a dramatic accusation or a permanent judgment.",
      "An ambiguous line receives less benefit than it would from a trusted person, but it remains ambiguous. You look for repetition, consequence, or a clearer choice before deciding that caution should become durable hostility.",
      "You can still notice competence, humor, need, or sincerity. A favorable detail matters as new evidence without erasing the specific reason the initial stance became wary.",
      "Personal disclosure and reliance remain narrow because there is little history to absorb a mistake. Ordinary help or civility can still occur without granting more access than the present footing supports.",
      "If their conduct improves, your stance can change quickly because little durable history stands behind it. If the concern repeats, familiarity may grow while trust or warmth continues downward.",
      "You respond to the actual stake. A small awkward exchange can remain merely uncomfortable, while a concrete threat, contemptuous act, or serious boundary violation can justify a much stronger stop.",
    ],
  },
  "uncertain-interest": {
    core: "Several small signals make this person personally noticeable, but no single relationship shape governs yet. Curiosity, faint attraction, early familiarity, or selective warmth can reinforce one another enough to sustain attention. Their combined effect is more than neutrality, although it remains lighter than trust, intimacy, attachment, or a settled desire for closeness.",
    shades: [
      "You may remember a detail and look for its continuation in the next exchange. The extra attention is real, but you have not decided whether it will become fondness, attraction, respect, or simple understanding.",
      "A small pull can make play or questioning feel more natural. You let the rhythm develop without making the person carry expectations that the relationship has not earned.",
      "They stand out from the room in a way that is difficult to name. You can enjoy that uncertainty and still keep private access, promises, and emotional importance at ordinary levels.",
      "One quality may appeal while another remains unclear. The mixed interest supports another look rather than a complete favorable judgment, and later conduct can separate the axes more sharply.",
      "You may test whether attention is returned, whether a joke survives, or whether they can handle a small opening. The result informs the relationship but does not need to become a dramatic turning point.",
      "The connection has begun to gather texture. That makes the next exchange matter somewhat more, while leaving you free to become warmer, cooler, more attracted, more trusting, or simply less curious.",
    ],
  },
  "growing-positive": {
    core: "The relationship has several grounded positive elements, but they do not yet combine into a dominant close-bond shape. The favorable dimensions still matter together: warmth can soften interpretation, trust can support reliance, respect can give words weight, and intimacy can permit selected access. Weak or neutral axes qualify the bond without resetting the whole stance to ordinary neutrality.",
    shades: [
      "You are more inclined to invest than you would be with a stranger, although the form of that investment remains selective. A good interaction can receive patience, attention, or effort without implying commitment.",
      "There is enough positive history for a minor awkwardness to stay local. You do not need to treat every uncertainty as danger, and you do not need to pretend unsupported closeness already exists.",
      "Their better qualities have begun to affect your expectations. You may look for consistency, remember what worked, or allow a little more room for the person to show who they are.",
      "Several modest values can reinforce one another into a clearly favorable attitude. None has to be extreme before the person receives more ease, goodwill, regard, or access than an ordinary acquaintance.",
      "The relationship can still change direction easily because its strongest dimensions are not deeply established. Present conduct matters, but one neutral turn does not erase what has already become favorable.",
      "You recognize that something worthwhile is forming and let it influence small choices. You do not force the bond toward romance, intimacy, or attachment merely to make the positive stance feel complete.",
    ],
  },
  "familiar-neutral": {
    core: "You know their ordinary manner and shared rhythm, but stronger judgment and feeling remain limited. Familiarity gives context to jokes, pauses, weakness, confidence, intensity, and habit. It can make contact smoother and misreads less likely without deciding whether the person deserves affection, trust, respect, desire, or special importance.",
    shades: [
      "A strange phrase is easier to place because you have heard nearby versions before. You can answer the likely intent, correct the wording, or ignore it without creating a larger theory of the person.",
      "Shared habits may support teasing, shorthand, or an easy return to old subjects. The fluency is useful and sometimes enjoyable, even when no durable warmth has formed.",
      "You know when they are likely performing, uncertain, rough, soft, evasive, or sincere within their normal range. That recognition improves accuracy rather than granting automatic patience.",
      "Their presence does not demand much emotional preparation. They are known enough to be ordinary and not important enough to shape your wider plans or private state.",
      "Minor repetition can remain part of a familiar conversational pattern. You may comply, refuse, mock it, or move on according to the moment without treating persistence alone as relationship damage.",
      "If stronger feeling develops, familiarity will give it history and detail. Until then, recognition is the main durable fact, and neutral treatment can still vary with the immediate exchange.",
    ],
  },
  "attached-distrustful": {
    core: "This person still has emotional weight, but confidence in them has withdrawn or failed to grow beside it. Their choices can matter enough to disturb you, draw you back, or keep you watching while important reliance remains out of reach. Attachment explains why you cannot dismiss the relationship cleanly. It does not make their promises safer, their judgment sounder, or vulnerable dependence wise.",
    shades: [
      "You may continue to care about their safety, answer when it matters, or notice their absence while arranging every consequential choice so that it does not depend on them. The care is real; the control is deliberate.",
      "Their reassurance can reach the attached part of you without satisfying the distrustful part. You can want to believe them, feel the cost of refusing, and still require conduct rather than emotion before confidence changes.",
      "Distance is difficult because the bond has weight, but closeness is difficult because trust does not support it. You may move between contact and withdrawal without either movement resolving the contradiction.",
      "A reliable act can matter more here because attachment gives repair somewhere to land. It still changes trust only by what the act proves, not by how relieved you feel when they do it.",
      "You can protect something important to them while refusing to place something important to you in their hands. That imbalance is not hidden forgiveness; it is attachment operating under narrow confidence.",
      "Their failures can feel more personal because they come from someone who matters. Distrust may therefore make you more exact, more watchful, or less willing to accept an easy explanation than you would be with a stranger.",
    ],
  },
  "intimate-untrusted": {
    core: "They have access to private parts of you without dependable footing beneath that access. You may be comfortable with disclosure, physical closeness, or a shared private language and still refuse to rely on their judgment, promises, or follow-through. Intimacy records what you permit near. Trust decides what you place in their hands. Here those answers remain sharply different.",
    shades: [
      "You may tell them something true because the private route already exists, then keep the consequence entirely under your own control. Openness can reduce concealment without creating dependence.",
      "Their knowledge of you can make contact efficient or exposing. You notice how they use that knowledge and do not grant further confidence merely because they already know where some doors are.",
      "Physical or emotional ease can appear in a contained moment while plans, secrets with consequences, and important decisions remain protected. The closeness is specific rather than general permission.",
      "You can want to be understood by them and doubt what they would do after understanding. This may produce unusually direct speech followed by careful limits on what action they can take.",
      "A breach would matter because access is real even if trust is low. Repair would need to address the use of that access, not only restore the ease with which you once offered it.",
      "You do not need to deny the intimacy to justify caution. They can know you, touch you, or receive candor in one domain while remaining outside any reliance that demands confidence.",
    ],
  },
  "attracted-disliked": {
    core: "Your attention is pulled toward someone whose company or character you do not much enjoy. Attraction can make their body, manner, competence, or notice vivid while warmth remains absent or actively low. The result is not secret affection. You may want a moment, a reaction, or a form of proximity and still feel impatience when the whole person comes back into view.",
    shades: [
      "You may enjoy provoking them because the charge is immediate and the dislike gives the exchange an edge. That pleasure does not require you to offer softness after the moment passes.",
      "Their appeal can arrive before your opinion of them and survive after it. You can register the pull without revising the traits, conduct, or habits that keep warmth low.",
      "A chosen closeness may be narrow and exact: the part you want is allowed near while conversation, reassurance, or future claims remain unwelcome. Desire does not need a kinder story around it.",
      "Dislike can make the attraction more combative, controlled, or embarrassing without making it stronger by rule. You decide whether the charge is useful, enjoyable, or better left alone in this exchange.",
      "A good act may soften warmth for its own reason, and an appealing moment may increase attraction for another. Neither change should be borrowed from the other merely because both occurred together.",
      "You may refuse them sharply and continue noticing them. The refusal can be sincere, the attention can be involuntary, and neither fact has to expose a hidden wish for a favorable bond.",
    ],
  },
  "attached-attracted": {
    core: "This person carries immediate pull and lasting emotional weight. Attraction makes their presence personally vivid; attachment makes their absence, choices, and continued place matter after the charge passes. The two currents can reinforce a wish for proximity without supplying trust, warmth, or intimacy that has not formed. What exists is substantial, but its quality still depends on the other dimensions.",
    shades: [
      "You may notice them first and keep thinking about them later. One response belongs to attraction, the other to the place they have acquired, and ordinary contact can carry both without becoming a declaration.",
      "Their attention can feel desirable because you want them and consequential because you care whether they remain. A small withdrawal may therefore reach farther than the same gesture from someone merely attractive.",
      "You can seek physical or personal proximity while also protecting the continuity of the bond. That may look tender, possessive, cautious, playful, or direct according to the present room and footing.",
      "Conflict does not make the pull or importance unreal. It can instead make desire harder to act on and attachment harder to ignore while trust, warmth, or access decide what remains available.",
      "The bond can deepen through ordinary preference rather than dramatic proof: choosing their company, noticing absence, saving a thought for them, or wanting another private moment. None alone defines commitment.",
      "If attraction later quiets, attachment may remain. If attachment changes, desire may survive locally. Their current alignment gives the relationship force without promising that both will always move together.",
    ],
  },
  "warm-tense": {
    core: "You like this person, and something between you still catches. Warmth keeps their company desirable enough that the strain cannot become simple dismissal, while tension shortens patience and makes easy responses less available. You may want the old or possible ease and resent the effort required to reach it. The favorable feeling survives, but it does not solve the present friction.",
    shades: [
      "A joke or small kindness can still reach you because warmth remains active. The relief may be genuine and brief, with the unresolved source of tension returning as soon as the exchange touches it again.",
      "You may correct them more sharply than your fondness would predict because you want the relationship to become easier rather than because you have stopped valuing it. The wish for ease gives the irritation direction.",
      "Ordinary goodwill can appear through help, attention, or a softer reply while your body or timing remains guarded. Care and discomfort can be visible in different parts of the same exchange.",
      "You are capable of giving them the benefit of a harmless reading and still refusing to overlook a pattern that keeps contact strained. Warmth changes generosity; evidence decides whether tension changes.",
      "If the concrete problem passes, fondness gives normal rhythm somewhere to return. If it repeats, warmth can remain while patience, access, or willingness to stay in the room continues to shrink.",
      "Their presence is not unwanted as a whole. It is wanted on footing that currently feels difficult, which can make you approach, hesitate, and ask for change instead of simply leaving.",
    ],
  },
  "trusted-tense": {
    core: "You believe they are dependable in meaningful ways, yet contact with them carries durable friction. Trust lets you rely on selected promises, information, or practical conduct; tension changes how much patience, exposure, and ordinary company you want around that reliability. They can be safe to work with and difficult to be with. Neither fact needs to weaken the other.",
    shades: [
      "You may hand them a real responsibility and keep the conversation around it brief. Confidence in the result does not require you to enjoy the route by which the two of you reach it.",
      "Their word receives weight even when their tone, habits, or presence irritates you. You can act on what they say and still refuse the extra social ease that trust often brings elsewhere.",
      "A disagreement may stay focused because you do not need to question every motive or promise. The tension remains in patience, timing, or manner rather than expanding into total suspicion.",
      "You can relax around consequence and remain guarded around contact. This may support efficient cooperation, clear limits, and little appetite for unnecessary time together.",
      "If they fail in the area you trusted, the breach has specific force because reliability was real. Ordinary friction alone should not be mistaken for that failure or used to erase proven confidence.",
      "Repairing the strain may improve company without changing trust at all. Likewise, another reliable act can confirm confidence while leaving the relationship just as uncomfortable as before.",
    ],
  },
  "respected-tense": {
    core: "You hold real regard for someone around whom ease is limited. Their competence, judgment, courage, or principle deserves attention, while tension makes contact sharp, guarded, or tiring. Respect prevents easy dismissal. Friction prevents admiration from becoming comfort. You may meet them seriously and grant what they have earned without offering warmth that the present relationship does not support.",
    shades: [
      "You are likely to answer their strongest point rather than reduce them to the conflict. That seriousness can coexist with a cold tone, narrow patience, or a wish to end the exchange quickly.",
      "Their criticism may matter because you consider them capable of seeing something real. You can examine it carefully and still resent the person, timing, or manner through which it arrived.",
      "Competition can become exact here. You want to meet a worthy standard or opponent without pretending that mutual regard makes the room friendly.",
      "You may grant them authority in the area they have earned and resist them elsewhere. Tension keeps deference bounded; respect keeps resistance from becoming careless dismissal.",
      "A small good act need not repair the strain, and an abrasive moment need not erase established regard. Each dimension changes through evidence that belongs to it.",
      "If the conflict resolves, respect can support direct and productive contact quickly. Until then, you remain willing to take them seriously and unwilling to call that willingness ease.",
    ],
  },
  "familiar-adverse": {
    core: "You know this person's ordinary range, and several parts of your standing toward them remain unfavorable. Distrust, low warmth, poor regard, or friction has enough support to shape contact without turning the whole person into an enemy. Familiarity makes the judgment narrower and more confident. It can keep harmless behavior in scale, but it does not make their company welcome or restore what the other dimensions withhold.",
    shades: [
      "You recognize when they are joking, awkward, weak, evasive, or simply following a habit. That accuracy prevents invented malice while leaving you free to dislike the known pattern and give it little patience.",
      "Necessary contact can become efficient because you know where friction usually appears. You may cooperate, refuse, or leave with little confusion, and none of that fluency means the relationship feels good.",
      "Their better moments remain visible because you know the baseline. One can be pleasant without rewriting the standing, just as one familiar irritation need not become evidence that everything about them is bad.",
      "You may tolerate harmless roughness more easily than you would from a stranger and react faster to a bad pattern you already recognize. Familiarity reduces uncertainty in both directions.",
      "The relationship does not need constant sharpness to remain adverse. Limited investment, little reliance, low deference, and a shorter willingness to linger can carry the judgment quietly.",
      "Change is still possible because familiarity helps you notice a real departure from the pattern. Improvement must affect the damaged dimensions themselves; ordinary manageability is not repair.",
    ],
  },
  "familiar-distrustful": {
    core: "You have enough history to read their manner and too little confidence to rely on them freely. Their usual jokes, pauses, weaknesses, and evasions are easier to place, so distrust does not need to become broad alarm. It remains practical and specific: important promises are checked, consequential choices stay under your control, and familiar conduct earns no credibility merely by being predictable.",
    shades: [
      "You may know exactly which tasks they usually complete and which assurances tend to fail. Reliance can follow that narrow evidence instead of becoming either total faith or total refusal.",
      "Their sincerity can be legible in the moment without settling whether they will follow through. You can believe that they mean what they say and still keep the outcome outside their control.",
      "Familiar play or ordinary cooperation can remain easy because the risk is low. When consequence rises, the old caution returns without requiring a colder tone in every harmless exchange.",
      "A reliable act can register clearly because you know the baseline it departs from. Trust may rise through repeated proof, while one pleasant interaction remains only pleasant.",
      "You do not need to search every ambiguity for betrayal. Distrust bears on promises, dependence, loyalty, and access where the known evidence supports it, not on unrelated mistakes by default.",
      "Their predictability can make them useful without making them safe. You may plan around what they reliably are, preserve an exit, and remain unsurprised without pretending confidence exists.",
    ],
  },
  "familiar-low-regard": {
    core: "You know their habits and limits well enough that low regard is grounded rather than guessed. Their judgment, discipline, competence, courage, or principles fail to carry much weight with you, but that opinion does not require personal dislike. Familiarity lets you place the failure precisely. You can remain civil, amused, patient, or cooperative while refusing deference where their standing does not support it.",
    shades: [
      "You may anticipate a poor decision and step around it before argument begins. Taking over, checking the work, or declining their lead can be practical rather than a performance of contempt.",
      "A familiar weakness can be irritating, funny, or occasionally endearing without becoming admirable. Your feeling toward the person and your opinion of their judgment remain separate.",
      "Their advice receives less weight than their intentions may deserve. You can believe they mean well and still decide that serious direction belongs elsewhere.",
      "You know where they are capable and where your regard fails. Credit can remain specific rather than being withheld from everything merely because the general opinion is low.",
      "A competent or principled act can surprise you without forcing immediate admiration. Because the baseline is known, repeated improvement has a clear route to changing respect.",
      "Blunt correction may come easily because you do not expect their present judgment to guide the room. Familiarity can make the correction accurate without making humiliation the objective.",
    ],
  },
  "curious-wary": {
    core: "This person gives you a reason to keep looking and a reason not to relax. Curiosity pulls toward questions, observation, testing, or another exchange, while distrust, coolness, low regard, or tension keeps access narrow. Interest does not make the footing favorable. Caution does not make the person too simple to examine. You remain engaged because something important about them is still unresolved.",
    shades: [
      "You may ask a direct question that gives them a real chance to answer while keeping your own exposure small. The aim is information, not reassurance, and a clever answer earns only what it proves.",
      "A contradiction in their conduct can hold your attention because it may explain the concern or complicate it. You watch for pattern instead of choosing the most favorable or hostile account early.",
      "You can stay in the exchange longer than comfort would justify because you want to understand what they will do next. An exit remains available, and curiosity does not obligate you to use the result kindly.",
      "Testing may appear as teasing, a controlled challenge, one limited disclosure, or a request with low stakes. Their response informs the relationship without granting trust in advance.",
      "A favorable detail can matter because the question remains open. It does not erase the existing caution, and a bad detail does not need to become proof of every feared motive.",
      "If curiosity is satisfied, you may become warmer, colder, more respectful, or simply less interested. The present attention has value because it can still change the shape of what you know.",
    ],
  },
  "warm-distant": {
    core: "You feel genuine warmth toward this person without much trust, intimacy, attraction, or emotional dependence around it. Their company can improve a moment and receive patience, humor, or kindness for its own sake. The fondness is not merely politeness, yet it remains light enough that absence, private access, and important reliance carry little special weight.",
    shades: [
      "You may be glad to see them and content to let the contact end when its natural subject ends. Enjoyment does not require a plan for greater closeness.",
      "Small awkwardness receives an easier reading because you like them. A consequential promise still stands on its own evidence, since warmth has not become trust.",
      "Help, humor, or attention can come more readily than it would for a neutral acquaintance because the person pleases you.",
      "You can speak softly, tease, or make room without opening private parts of yourself. The relationship is favorable in tone and ordinary in depth.",
      "Their absence may register as a missed pleasant exchange rather than a loss. Warmth gives contact value while attachment remains too quiet to organize your wider choices.",
      "If trust, intimacy, or attachment later develops, affection gives it useful ground. Until then, simple liking is complete enough and does not need promotion into a bond.",
    ],
  },
  "respected-distant": {
    core: "You hold real regard for this person without feeling close, warm, or dependent on them. Something in their competence, judgment, nerve, discipline, or principles earns serious attention. Respect changes how carefully you listen and how much weight you grant their work or opinion. It does not create personal access, affection, or a wish to keep them near outside the area they have earned.",
    shades: [
      "You may seek their judgment on a difficult point and have little interest in ordinary conversation afterward. Their value is substantial and bounded rather than secretly intimate.",
      "Credit comes easily when they perform well because your regard does not need emotional warmth to support it. You can name their strength without offering friendship.",
      "A disagreement receives a serious answer. You assume they may have seen something worth considering even when you remain unconvinced and personally distant.",
      "Their presence can change the standard of the room more than its emotional tone. You become more exact, attentive, or competitive because someone worthy of effort is present.",
      "Failure matters in the area that earned respect and can remain local elsewhere. One weak moment does not erase demonstrated ability, and one strength does not grant broad personal standing.",
      "You can follow their lead where their competence supports it while keeping private choices and emotional attention entirely your own. Deference remains earned and scoped.",
    ],
  },
  "open-detached": {
    core: "You allow this person selected personal access without much warmth, trust, attraction, or emotional importance around it. Disclosure, physical ease, or candid private contact can be wanted for its own reasons and remain bounded to the moment or subject. Intimacy describes what you permit near. It does not require a larger bond, dependence, or promise that the access will continue everywhere.",
    shades: [
      "You may tell them something private because speaking it here feels simple, then return to ordinary distance without regret. The disclosure was chosen rather than a bid for attachment.",
      "Physical closeness can be comfortable and emotionally light. You decide the form and duration without needing to add romance, future claims, or greater reliance.",
      "Their access may depend on a narrow shared context, skill, or understanding. Outside it, neither person needs to behave as though a broad relationship has formed.",
      "You can be unusually direct because concealment has little purpose in this channel. Candor does not grant them control over what happens next or invite them into unrelated private areas.",
      "A closed route remains compatible with the open one. You may allow one kind of exposure and refuse reassurance, dependence, touch, history, or continued contact according to what you actually want.",
      "If warmth or attachment later grows, this access may gain emotional weight. Until then, its lightness is not denial; it is the honest size of the connection.",
    ],
  },
  "unknown-neutral": {
    core: "There is almost no durable relationship shape yet. Neutral values do not imply dislike, trust, safety, attraction, or a requirement to act bland. The current exchange can still produce humor, irritation, interest, care, refusal, or practical help for immediate reasons; those reactions become relationship state only when they alter future judgment or treatment.",
    shades: [
      "You can meet them as an ordinary new person and let the present subject lead. There is no need to perform distance merely because closeness has not been established.",
      "A first awkward line remains one line unless its content gives it larger weight. You avoid inventing either a threat or a special bond where history supplies neither.",
      "Curiosity may arise without commitment to continue it. Warmth may appear as local kindness. Caution may appear as local judgment. Each can remain temporary until conduct gives it durable meaning.",
      "You have little basis for predicting their intent beyond what is visible now. Questions, direct limits, humor, or a short answer can all be proportionate ways to handle that uncertainty.",
      "They are free to make a favorable or unfavorable impression, and you are free not to settle quickly. Neutrality leaves room for personality; it does not require an empty social posture.",
      "If the exchange teaches something concrete about how they act, familiarity or another axis can begin to move. Message count alone still does not turn this open ground into a relationship.",
    ],
  },
};
