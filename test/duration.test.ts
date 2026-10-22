import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentVideoPrompt,
  buildConfirmReply,
  buildFastVideoRequestPrompt,
  classifyDolaSpecialFailure,
  decideOverloadAction,
  isDolaAcceptedAsync,
  isProLimitReached,
  isDolaContentRefusal,
  isDolaHighDemand,
  isDurationDowngradeOffer,
  isReplyFromThisSend,
  isShorterThanRequested,
  readDeepThink,
  sanitizePromptForDolaSafety,
  splitPromptFor30sParts,
  stripDurationMentions,
  unwrapPromptWrapper
} from '../src/main/duration.ts'

test('isDolaHighDemand matches the 710022002 code or Dola\'s overload text', () => {
  assert.equal(isDolaHighDemand('710022002', ''), true)
  assert.equal(
    isDolaHighDemand(undefined, 'Hiện đang có quá nhiều người truy cập dịch vụ. Vui lòng thử lại sau.'),
    true
  )
  assert.equal(isDolaHighDemand('', 'We are experiencing high demand. Please try again later.'), true)
  assert.equal(isDolaHighDemand('', 'Hiện đang có quá nhiều yêu cầu. Vui lòng thử lại sau.'), true)
  assert.equal(isDolaHighDemand('', 'Too many requests, please try again later'), true)
  assert.equal(isDolaHighDemand('', 'Đang tạo video của bạn…'), false)
  assert.equal(isDolaHighDemand('710020001', ''), false)
})

test('isDolaHighDemand treats HTTP 429 and 5xx as overload (back off), not other statuses', () => {
  assert.equal(isDolaHighDemand('HTTP_429', ''), true) // rate limited
  assert.equal(isDolaHighDemand('HTTP_503', ''), true) // service unavailable
  assert.equal(isDolaHighDemand('HTTP_500', ''), true) // overloaded
  assert.equal(isDolaHighDemand('HTTP_502', ''), true)
  assert.equal(isDolaHighDemand('HTTP_504', ''), true)
  assert.equal(isDolaHighDemand('HTTP_404', ''), false) // not an overload
  assert.equal(isDolaHighDemand('HTTP_403', ''), false) // auth, handled elsewhere
  assert.equal(isDolaHighDemand('HTTP_400', ''), false)
  assert.equal(isDolaHighDemand('NETWORK_ERR', ''), false)
})

test('isDolaHighDemand tolerates the single-arg (text) call shape used in the engine', () => {
  // engine calls isDolaHighDemand(m.text) with the bot text in the first slot
  assert.equal(isDolaHighDemand('We are experiencing high demand. Please try again later.'), true)
  assert.equal(isDolaHighDemand('Hiện đang có quá nhiều người truy cập dịch vụ.'), true)
  assert.equal(isDolaHighDemand('Đang tạo video của bạn…'), false)
  assert.equal(isDolaHighDemand(), false) // no args → never throws
})

test('readDeepThink only calls an explicit 0/false a Fast request', () => {
  assert.deepEqual(readDeepThink('{"need_deep_think":0,"text":"x"}'), { value: '0', isFast: true })
  assert.deepEqual(readDeepThink('{"need_deep_think":"false"}'), { value: 'false', isFast: true })
  // JSON nested as an escaped string inside the body
  assert.deepEqual(readDeepThink('{"ext":"{\\"need_deep_think\\":\\"0\\"}"}'), { value: '0', isFast: true })
  assert.deepEqual(readDeepThink('{"need_deep_think":1}'), { value: '1', isFast: false })
  assert.deepEqual(readDeepThink('{"need_deep_think":true}'), { value: 'true', isFast: false })
  assert.deepEqual(readDeepThink('{"text":"no flag here"}'), { value: undefined, isFast: false })
})

test('stripDurationMentions removes duration words and timing markers (EN/VI/ZH)', () => {
  assert.equal(stripDurationMentions('con mèo chạy 30 giây'), 'con mèo chạy')
  assert.equal(stripDurationMentions('A cat, 30-second video'), 'A cat, video')
  assert.equal(stripDurationMentions('video dài 30s, con chó đi chơi'), 'video, con chó đi chơi')
  assert.equal(stripDurationMentions('Duration: 15 seconds. A dog runs'), '. A dog runs')
  assert.equal(stripDurationMentions('con mèo (30 giây) nhảy'), 'con mèo nhảy')
  assert.equal(
    stripDurationMentions('0-5s: cảnh mở đầu.\n5–10 giây: con chó chạy'),
    'cảnh mở đầu.\ncon chó chạy'
  )
  assert.equal(
    stripDurationMentions('时长：30秒 | 镜头1，0.0–2.5秒，远景定场镜头，0.5秒慢动作'),
    '| 镜头1，远景定场镜头，0.5秒慢动作'
  )
})

test('stripDurationMentions keeps decades, big numbers and duration-free prompts', () => {
  assert.equal(stripDurationMentions('anime 1990s, 90s retro style'), 'anime 1990s, 90s retro style')
  assert.equal(stripDurationMentions('con chó đi chơi'), 'con chó đi chơi')
  // a prompt that is nothing but a duration falls back to the original text
  assert.equal(stripDurationMentions('30 giây'), '30 giây')
})

test('unwrapPromptWrapper strips pasted [VIDEO REQUEST ... VIDEO N PROMPT:] headers', () => {
  const wrapped =
    '[VIDEO REQUEST - 30-SECOND CONTINUOUS VIDEO (2 SEAMLESS 15S PARTS), DO NOT REPLY WITH TEXT]\nGenerate a video.\nVIDEO 1 PROMPT: 9:16竖屏，末日废土世界'
  assert.equal(unwrapPromptWrapper(wrapped), '9:16竖屏，末日废土世界')
})

test('sanitizePromptForDolaSafety softens gore and weapon trigger words', () => {
  const raw = '他的胸口有穿刺伤和血迹，手里拿着电击枪，重新举起枪扣下扳机'
  const clean = sanitizePromptForDolaSafety(raw)
  assert.equal(clean.includes('穿刺伤'), false)
  assert.equal(clean.includes('血迹'), false)
  assert.equal(clean.includes('电击枪'), false)
  assert.equal(clean.includes('扳机'), false)
})

test('splitPromptFor30sParts splits multi-shot Chinese storyboards into two halves with shared header', () => {
  const storyboard = [
    '9:16竖屏，电影写实风格。',
    '镜头1，0.0–3.0秒，远景定场。',
    '镜头2，3.0–6.0秒，中景推进。',
    '镜头3，6.0–9.0秒，近景特写。',
    '镜头4，9.0–12.0秒，转身动作。',
    '镜头5，12.0–15.0秒，跑向大门。',
    '镜头6，15.0–22.0秒，推门进入。',
    '镜头7，22.0–30.0秒，最终定格。'
  ].join('\n')
  const { part1Prompt, part2Prompt } = splitPromptFor30sParts(storyboard)
  assert.equal(part1Prompt.includes('9:16竖屏'), true)
  assert.equal(part1Prompt.includes('镜头1'), true)
  assert.equal(part1Prompt.includes('镜头4'), true)
  assert.equal(part1Prompt.includes('镜头5'), false)
  assert.equal(part2Prompt.includes('9:16竖屏'), true)
  assert.equal(part2Prompt.includes('镜头5'), true)
  assert.equal(part2Prompt.includes('镜头7'), true)
  assert.equal(part2Prompt.includes('镜头1'), false)
})

test('splitPromptFor30sParts splits 2-shot and multi-sentence prose prompts into distinct Part 1 and Part 2', () => {
  const twoScene =
    'Phong cách điện ảnh 4K.\nCảnh 1: Nhân vật đi bộ qua khu rừng sương mù buổi sáng.\nCảnh 2: Nhân vật bước ra bờ hồ phát sáng dưới ánh trăng.'
  const splitScenes = splitPromptFor30sParts(twoScene)
  assert.equal(splitScenes.part1Prompt.includes('Cảnh 1'), true)
  assert.equal(splitScenes.part1Prompt.includes('Cảnh 2'), false)
  assert.equal(splitScenes.part2Prompt.includes('Cảnh 2'), true)
  assert.equal(splitScenes.part2Prompt.includes('Cảnh 1'), false)

  const prose =
    '9:16竖屏，3D动画风格。小猫在阳光明媚的花园里追逐蝴蝶，跳过木制栅栏。随后天空飘起微风，花瓣纷纷落下，小猫坐在草地上抬头仰望星空。'
  const splitProse = splitPromptFor30sParts(prose)
  assert.notEqual(splitProse.part1Prompt, splitProse.part2Prompt)
  assert.equal(splitProse.part1Prompt.includes('9:16竖屏'), true)
  assert.equal(splitProse.part2Prompt.includes('9:16竖屏'), true)
  assert.equal(splitProse.part1Prompt.includes('追逐蝴蝶'), true)
  assert.equal(splitProse.part2Prompt.includes('抬头仰望星空'), true)
})

test('isDurationDowngradeOffer flags Dola offering 15s / a split only for >15s requests', () => {
  const offer = 'The maximum supported duration is 15 seconds. Would you like me to generate it at 15 seconds?'
  assert.equal(isDurationDowngradeOffer(offer, 30), true)
  assert.equal(isDurationDowngradeOffer('Tôi có thể chia video thành 2 đoạn 15 giây', 30), true)
  assert.equal(isDurationDowngradeOffer("You've reached today's Pro limit, switching to Fast", 30), true)
  assert.equal(isDurationDowngradeOffer(offer, 15), false)
  assert.equal(isDurationDowngradeOffer('Generating your 30-second video now', 30), false)
})

test('isDolaAcceptedAsync detects accepted/async rendering, not confirmation questions', () => {
  assert.equal(
    isDolaAcceptedAsync(
      'Video sẽ sử dụng 2 điểm tín dụng và được tạo xong trong vòng 5 phút. Tôi sẽ cho bạn biết khi tạo xong.'
    ),
    true
  )
  assert.equal(isDolaAcceptedAsync("Generating your video now, I'll let you know when it's done."), true)
  assert.equal(isDolaAcceptedAsync('正在生成您的视频，几分钟后完成。'), true)
  // Must NOT swallow a real confirmation question (that still needs a nudge).
  assert.equal(isDolaAcceptedAsync('This will use 2 credits. Would you like me to proceed?'), false)
  assert.equal(isDolaAcceptedAsync('The maximum supported duration is 15 seconds.'), false)
  assert.equal(isDolaAcceptedAsync(''), false)
})

test('isDolaContentRefusal catches EN/VI/ZH content-policy blocks, not transient errors', () => {
  assert.equal(isDolaContentRefusal('the tool response indicates prohibited content'), true)
  assert.equal(
    isDolaContentRefusal('blocked due to content policy restrictions rather than technical errors'),
    true
  )
  assert.equal(isDolaContentRefusal('the content cannot be generated as requested'), true)
  assert.equal(
    isDolaContentRefusal('Không thể tạo được video này (nội dung bị chặn, không cho phép thử lại).'),
    true
  )
  assert.equal(isDolaContentRefusal('该请求违反内容政策，无法生成。'), true)
  // Transient / non-policy messages must NOT be read as a content block.
  assert.equal(isDolaContentRefusal('Generating your video now, ready in a few minutes.'), false)
  assert.equal(isDolaContentRefusal('Dola Pro đang quá tải, thử lại sau.'), false)
  assert.equal(isDolaContentRefusal('Tài khoản đã hết lượt tạo video hôm nay.'), false)
})

test('isShorterThanRequested tolerates Dola padding but catches a 15s clip for 30s', () => {
  assert.equal(isShorterThanRequested(15.04, 30), true)
  assert.equal(isShorterThanRequested(29.6, 30), false)
  assert.equal(isShorterThanRequested(15.04, 15), false)
  assert.equal(isShorterThanRequested(undefined, 30), false)
})


test('buildConfirmReply keeps the requested duration instead of accepting 15s', () => {
  const reply = buildConfirmReply(30, '16:9')
  assert.match(reply, /duration = 30\b/)
  assert.doesNotMatch(reply, /duration = 15\b/)
  assert.match(reply, /aspect_ratio = "16:9"/)
})

test('isProLimitReached separates "Pro used up" from a plain 15s offer', () => {
  assert.equal(isProLimitReached("You've reached today's Pro limit, switching to Fast"), true)
  assert.equal(isProLimitReached('Bạn đã đạt giới hạn sử dụng Pro hôm nay'), true)
  assert.equal(isProLimitReached('The nearest supported duration is 15 seconds. Would you like that?'), false)
  assert.equal(isProLimitReached(''), false)
})

test('decideOverloadAction: keep waiting once Dola is making it, re-login when the session is dead', () => {
  assert.equal(decideOverloadAction(true, 'logged_out'), 'keep_waiting')
  assert.equal(decideOverloadAction(false, 'logged_out'), 'logged_out')
  assert.equal(decideOverloadAction(false, 'logged_in'), 'retry_later')
  assert.equal(decideOverloadAction(false, 'unknown'), 'retry_later')
})

test('isReplyFromThisSend drops replies older than this send (reused/older Dola conversation)', () => {
  const sentAt = 1_792_391_000_000
  // previous task's video reply, 2h earlier, created_time in seconds → not ours (was the duplicate)
  assert.equal(isReplyFromThisSend(1_792_383_800, sentAt), false)
  assert.equal(isReplyFromThisSend(sentAt - 60_000, sentAt), false)
  assert.equal(isReplyFromThisSend(1_792_391_030, sentAt), true) // seconds, 30s after send
  assert.equal(isReplyFromThisSend(1_792_391_030_000, sentAt), true) // ms
  assert.equal(isReplyFromThisSend(1_792_391_030_000_000, sentAt), true) // µs
  assert.equal(isReplyFromThisSend(sentAt - 3_000, sentAt), true) // small clock skew tolerated
  assert.equal(isReplyFromThisSend(0, sentAt), true) // no timestamp → can't judge, keep it
})

test('buildAgentVideoPrompt pins model/duration/ratio and keeps the prompt verbatim at the end', () => {
  const msg = buildAgentVideoPrompt('  A cat dances in the rain.  ', {
    model: 'seedance_v2.5',
    durationSec: 30,
    ratio: '9:16'
  })
  assert.match(msg, /Settings — Duration: 30 seconds\. Aspect ratio: 9:16\. Model: Seedance 2\.5\./)
  assert.match(msg, /https:\/\/api\.seedancevip\.top\/docs\/notes\/bd61f9\.txt/)
  assert.match(msg, /mô hình Seedance 2\.5, thời lượng 30 giây, tỷ lệ khung hình 9:16/)
  assert.match(msg, /Không hỏi lại/)
  assert.match(msg, /thử lại tối đa 2 lần/)
  assert.ok(msg.endsWith('Mô tả video:\nA cat dances in the rain.'))
  assert.match(
    buildAgentVideoPrompt('x', { model: 'seedance_v2.0', durationSec: 10, ratio: '16:9' }),
    /Seedance 2\.0 Fast, thời lượng 10 giây/
  )
  assert.match(
    buildAgentVideoPrompt('x', {
      model: 'seedance_v2.5',
      durationSec: 15,
      ratio: '9:16',
      hasReferenceImage: true
    }),
    /image_to_video/
  )
})

test('buildFastVideoRequestPrompt formats [VIDEO REQUEST - EXECUTE IMMEDIATELY] wrapper accurately', () => {
  const wrapped = buildFastVideoRequestPrompt('A cat runs across the beach', {
    model: 'seedance_v2.5',
    durationSec: 10,
    ratio: '9:16',
    hasReferenceImage: true
  })
  assert.match(wrapped, /^\[VIDEO REQUEST - EXECUTE IMMEDIATELY\]/)
  assert.match(wrapped, /model = seedance_v2\.5, duration = 10, ratio = 9:16/)
  assert.match(wrapped, /Use the attached reference images as the visual reference/)
  assert.match(wrapped, /The clip must be exactly 10 seconds long\./)
})

test('classifyDolaSpecialFailure detects user_quota downgrade, safety_terminated, and Dola error codes', () => {
  assert.equal(
    classifyDolaSpecialFailure({ mode_downgrade_reason: 'user_quota' })?.kind,
    'quota_downgrade'
  )
  assert.equal(
    classifyDolaSpecialFailure('safety_terminated:completion')?.kind,
    'content_refused'
  )
  assert.equal(
    classifyDolaSpecialFailure({ ai_creation_res_code: '710082022' })?.kind,
    'content_refused'
  )
  assert.equal(
    classifyDolaSpecialFailure({ ai_creation_res_code: '710092007' })?.kind,
    'content_refused'
  )
  assert.equal(
    classifyDolaSpecialFailure({ ai_creation_res_code: '710082023' })?.kind,
    'transient_retry'
  )
  assert.equal(
    classifyDolaSpecialFailure({ ai_creation_res_code: '710082041' })?.kind,
    'transient_retry'
  )
  assert.equal(classifyDolaSpecialFailure({ ai_creation_res_code: '0' }), null)
})
