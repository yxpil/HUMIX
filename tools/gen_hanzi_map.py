# -*- coding: utf-8 -*-
# 生成汉字 → 带调数字拼音映射表(GB2312 一级 3755 字,多音字取常用读音)
# 输出:src/pinyin/hanziMap.ts(约 3755 条)
from pypinyin import lazy_pinyin, Style

# GB2312 一级汉字:区 16-55,位 01-94
chars = []
for area in range(16, 56):
    for pos in range(1, 95):
        b1 = 0xA0 + area
        b2 = 0xA0 + pos
        try:
            ch = bytes([b1, b2]).decode("gb2312")
        except Exception:
            continue
        chars.append(ch)
print("汉字数:", len(chars))

mapping = {}
for ch in chars:
    py = lazy_pinyin(ch, style=Style.TONE3)
    syl = py[0] if py else ""
    if syl and syl[0].isalpha():
        mapping[ch] = syl

# 补充常用字(可能不在 GB2312 一级)
extra = "嗯哦呗啦咯唉哟诶唷哪呀吧呢吗嘛啊哈哇"
for ch in extra:
    py = lazy_pinyin(ch, style=Style.TONE3)
    if py and py[0][0].isalpha():
        mapping.setdefault(ch, py[0])

print("映射条数:", len(mapping))
# 抽样
for ch in "你好世界今天天气真好我们一起唱歌吧":
    print(f"  {ch} -> {mapping.get(ch, '?')}")

lines = [
    "// ============ 汉字 → 带调拼音映射(自动生成,勿手改) ============",
    "// 来源:tools/gen_hanzi_map.py(GB2312 一级 3755 字 + 常用补充,多音字取常用读音)",
    f"// 共 {len(mapping)} 字",
    "export const HANZI: Record<string, string> = {",
]

def json_quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

for ch in sorted(mapping):
    lines.append(f'  {json_quote(ch)}: "{mapping[ch]}",')
lines.append("};")
lines.append("")

with open("src/pinyin/hanziMap.ts", "w", encoding="utf-8") as fp:
    fp.write("\n".join(lines))
print("已写出 src/pinyin/hanziMap.ts")
