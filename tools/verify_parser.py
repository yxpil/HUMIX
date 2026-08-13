# -*- coding: utf-8 -*-
# 验证 PinyinParser 的 TS 逻辑:镜像实现,对全部 412 音节列表做解析断言
INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l",
            "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"]
APICAL = {"zh", "ch", "sh", "r", "z", "c", "s"}
FINALS = ["iang", "uang", "iong", "uai", "ian", "uan", "iao", "iu", "ui",
          "ing", "ong", "ang", "eng", "ai", "ei", "ao", "ou", "ia", "ie",
          "ua", "uo", "üe", "üan", "an", "en", "in", "un", "ü", "er",
          "a", "o", "e", "i", "u", "ue"]

def parse(syl):
    syl = syl.replace("v", "ü").lower()
    initial, final = None, ""
    for f in FINALS:
        if not syl.endswith(f):
            continue
        ini = syl[:len(syl) - len(f)]
        if ini == "":
            initial, final = None, f
            break
        if ini in INITIALS:
            initial, final = ini, f
            break
    if not final:
        return None
    if initial in APICAL and final == "i":
        final = "ii"
    if final == "ue":
        final = "üe"
    if initial == "y" or (initial and initial in "jqx"):
        if final == "u": final = "ü"
        elif final == "un": final = "ün"
        elif final == "ue": final = "üe"
        elif final == "uan": final = "üan"
    return (initial, final)

GROUPS = [
    "ba bo bai bei bao ban ben bang beng bi bie biao bian bin bing bu",
    "pa po pai pei pao pou pan pen pang peng pi pie piao pian pin ping pu",
    "ma mo me mai mei mao mou man men mang meng mi mie miao miu mian min ming mu",
    "fa fo fei fou fan fen fang feng",
    "da de dai dei dao dou dan den dang deng dong di die diao diu dian ding du duo dui duan dun",
    "ta te tai tao tou tan tang teng tong ti tie tiao tian ting tu tuo tui tuan tun",
    "na ne nai nei nao nou nan nen nang neng nong ni nie niao niu nian nin niang ning nu nuo nuan nun nü nüe",
    "la le lai lei lao lou lan lang leng long li lia lie liao liu lian lin liang ling lu luo luan lun lü lüe",
    "ga ge gai gei gao gou gan gen gang geng gong gu gua guo guai gui guan gun guang",
    "ka ke kai kao kou kan ken kang keng kong ku kua kuo kuai kui kuan kun kuang",
    "ha he hai hei hao hou han hen hang heng hong hu hua huo huai hui huan hun huang",
    "ji jia jie jiao jiu jian jin jiang jing jiong ju jue juan jun",
    "qi qia qie qiao qiu qian qin qiang qing qiong qu que quan qun",
    "xi xia xie xiao xiu xian xin xiang xing xiong xu xue xuan xun",
    "zha zhe zhi zhai zhei zhao zhou zhan zhen zhang zheng zhong zhu zhua zhuo zhuai zhui zhuan zhun zhuang",
    "cha che chi chai chao chou chan chen chang cheng chong chu chua chuo chuai chui chuan chun chuang",
    "sha she shi shai shao shou shan shen shang sheng shu shua shuo shuai shui shuan shun shuang",
    "re ri rao rou ran ren rang reng rong ru rua ruo rui ruan run",
    "za ze zi zai zei zao zou can cen cang zeng zong zu zuo zui zuan zun",
    "ca ce ci cai cao cou can cen cang ceng cong cu cuo cui cuan cun",
    "sa se si sai sao sou san sen sang seng song su suo sui suan sun",
    "ya yo ye yao you yan yin yang ying yong yu yue yuan yun",
    "wa wo wai wei wan wen wang weng wu",
    "a ai an ang ao e ei en eng er o ou",
]
syllables = [s for g in GROUPS for s in g.split()]
print("音节总数:", len(syllables))

mismatch = 0
for syl in syllables:
    r = parse(syl)
    if r is None:
        print(f"  !! 解析失败: {syl}")
        mismatch += 1
        continue
    exp_ini, exp_fin = None, syl
    for it in sorted(INITIALS, key=len, reverse=True):
        if syl.startswith(it):
            exp_ini, exp_fin = it, syl[len(it):]
            break
    exp_fin = exp_fin.replace("v", "ü")
    if exp_fin == "u" and (exp_ini == "y" or (exp_ini and exp_ini in "jqx")): exp_fin = "ü"
    elif exp_fin == "un" and (exp_ini == "y" or (exp_ini and exp_ini in "jqx")): exp_fin = "ün"
    elif exp_fin == "ue" and (exp_ini == "y" or (exp_ini and exp_ini in "jqx")): exp_fin = "üe"
    elif exp_fin == "uan" and (exp_ini == "y" or (exp_ini and exp_ini in "jqx")): exp_fin = "üan"
    if exp_ini in APICAL and exp_fin == "i": exp_fin = "ii"
    if r != (exp_ini, exp_fin):
        print(f"  !! 不一致 {syl}: parse={r} 期望={(exp_ini, exp_fin)}")
        mismatch += 1
print(f"完成,{len(syllables) - mismatch}/{len(syllables)} 一致")

import re as _re
for t in ["ni3 hao3", "wo3 ai4 ni3", "shi4 jie4", "zhong1 guo2 ren2",
          "lv4 se4", "yue4 liang5", "xiong2 mao1", "ni hao", "er2 tong2",
          "nv3 sheng1", "jue2 dui4", "yi2 yang4"]:
    toks = [_re.sub(r"[0-5]$", "", tk.replace("v", "ü")) for tk in t.split()]
    print(f"  parse({t!r}) ->", [parse(s) for s in toks])
