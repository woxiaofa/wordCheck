# 生成答题音效（2026-10-10 #36）：correct.mp3 清脆上行双音、wrong.mp3 低沉短音。
# 用 lameenc 直接编码合成 PCM，不依赖外部素材 —— 每个文件几 KB，随主包走不占音频分包。
import math, struct, os, lameenc

SR = 22050
OUT = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'assets', 'sfx')
os.makedirs(OUT, exist_ok=True)

def tone(freq, dur, vol=0.5, decay=True):
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        env = math.exp(-3.0 * t / dur) if decay else 1.0
        out.append(vol * env * math.sin(2 * math.pi * freq * t))
    return out

def mix(a, b, offset):
    n = max(len(a), offset + len(b))
    out = [0.0] * n
    for i, v in enumerate(a): out[i] += v
    for i, v in enumerate(b): out[offset + i] += v
    return out

def save(name, samples):
    pcm = b''.join(struct.pack('<h', int(max(-1, min(1, s)) * 32767)) for s in samples)
    enc = lameenc.Encoder()
    enc.set_bit_rate(48)
    enc.set_in_sample_rate(SR)
    enc.set_channels(1)
    enc.set_quality(2)
    data = enc.encode(pcm) + enc.flush()
    path = os.path.join(OUT, name)
    with open(path, 'wb') as f:
        f.write(data)
    print(name, len(data), 'bytes')

# 答对：E5(659) -> A5(880) 快速上行 + 末端叠一个高八度泛音，听感"叮！"，总长 ~0.5s
correct = mix(
    mix(tone(659, 0.18, 0.45), tone(880, 0.32, 0.45), int(SR * 0.10)),
    tone(1318, 0.20, 0.18), int(SR * 0.10))
save('correct.mp3', correct)

# 答错：180Hz 低音 + 轻微不协和（170Hz），0.28s，低沉但不刺耳
wrong = mix(tone(180, 0.28, 0.40, decay=False), tone(170, 0.28, 0.25, decay=False), 0)
# 线性淡出避免爆音
fade = int(SR * 0.05)
for i in range(fade):
    wrong[-fade + i] *= i / fade
save('wrong.mp3', wrong)
