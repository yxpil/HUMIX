# -*- coding: utf-8 -*-
# 从 XStudio exe 提取 UI 文本:v2 — 常用字过滤(真 UI 词条几乎全用常用汉字)
import re, sys, os

path = r"C:/Program Files/NetEase Cloud Music XStudio/NetEase Cloud Music XStudio.exe"
ts = open(r"C:/Users/Admin/OneDrive/Desktop/HUMIX/src/pinyin/hanziMap.ts", encoding="utf-8").read()
common = set(re.findall(r'"([\u4e00-\u9fff])":', ts))
print("常用字表:", len(common))

data = open(path, "rb").read()
txt16 = data.decode("utf-16-le", errors="ignore")

pat = re.compile(r"[\u4e00-\u9fff][\u4e00-\u9fff\u3000-\u303f\uff00-\uff5e·×÷]{1,11}")
strs = set()
for m in pat.finditer(txt16):
    s = m.group().strip("。、，！？；：·")
    if len(s) < 2:
        continue
    cn = [c for c in s if "\u4e00" <= c <= "\u9fff"]
    if len(cn) < 2:
        continue
    # 常用字占比 ≥ 80%
    rare = sum(1 for c in cn if c not in common)
    if rare / len(cn) > 0.2:
        continue
    strs.add(s)

print("提取中文串:", len(strs))
with open(r"C:/Users/Admin/OneDrive/Desktop/HUMIX/tools/xstudio_strings.txt", "w", encoding="utf-8") as fp:
    for s in sorted(strs, key=lambda x: (len(x), x)):
        fp.write(s + "\n")
print("已写出 tools/xstudio_strings.txt")
