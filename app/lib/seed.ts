// Emergency fallback data (real chart tracks, Sep 2026). Labeled source:"seed" in API responses.
import type { Track } from "./innertube";

function t(videoId: string, title: string, artists: string, rank: number): Track {
  return { rank, videoId, title, artists, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` };
}

export const SEEDS: Record<string, Track[]> = {
  US: [
    t("fcnDmrtj6Sk", "Dai Dai", "Shakira & Burna Boy", 1),
    t("nUsrYVxrDwI", "Choosin' Texas", "Ella Langley", 2),
    t("Tk9TM7-eTmw", "Joseph", "Serj Tankian, Corey Taylor & Falling in Reverse", 3),
    t("ApXoWvfEYVU", "Sunflower", "Post Malone & Swae Lee", 4),
    t("qwaVhOZkAek", "Let’s Get Married", "Miley Cyrus", 5),
    t("yebNIHKAC4A", "Golden", "HUNTR/X, EJAE, AUDREY NUNA & REI AMI", 6),
    t("hLOheGDwD_0", "Choosin' Texas", "Ella Langley", 7),
    t("y56D2WIeKxg", "DRAKE - QUEBEC", "Drake", 8),
    t("xxFjwI1qYmc", "WTF GOIN", "21 Savage & Belly Gang Kushington", 9),
    t("Gs069dndIYk", "September", "Earth, Wind & Fire", 10),
  ],
  IN: [
    t("s2HYl12gmOY", "Parvati", "Sadhu Tiwari", 1),
    t("vRjaGgDsWSo", "Casa Tupka Anthemo | @YoYoHoneySingh  feat. Priyanshi | Full Video", "Yo Yo Honey Singh", 2),
    t("JqFzhcWo3EU", "Yeshanagula (From The Paradise) (Telugu)", "Jangi Reddy, Singer Prabha & Kasarla Shyam", 3),
    t("xvT1jH8B9AM", "KALYANI (Remix)", "ARJN, KDS, FIFTY4 & Shreya Ghoshal", 4),
    t("A_RV2H2F9jw", "Basinga Balaalu", "Srinidhi Nerella, Kalyan Keys & Swamy Naresh", 5),
    t("rjfxLq3OQ0w", "Parvati", "Sadhu Tiwari", 6),
    t("ebZj_nrmH-c", "Barsaat", "Banjaare & Roni", 7),
    t("zoBTw-1vzyY", "Endhayya Saami | Ranabaali | Full Song | Vijay Deverakonda, Rashmika | Rahul Sankrityan | Ajay–Atul", "Ramajogayya Sastry, Ajay Gogavale, Ajay Gogavale & Shweta Mohan", 8),
    t("u9BdaJTWeiw", "Barbaadi", "Shilpi Raj", 9),
    t("YyepU5ztLf4", "Shararat", "Madhubanti Bagchi, Jasmine Sandlas & Shashwat Sachdev", 10),
  ],
  GB: [
    t("fcnDmrtj6Sk", "Dai Dai", "Shakira & Burna Boy", 1),
    t("qwaVhOZkAek", "Let’s Get Married", "Miley Cyrus", 2),
    t("Lufa9QAFFeY", "new trick", "ROSÉ", 3),
    t("yebNIHKAC4A", "Golden", "HUNTR/X, EJAE, AUDREY NUNA & REI AMI", 4),
    t("mO_GC1z_bmc", "Bad Guys (Official Music Video)", "Ana Sky", 5),
    t("lhCPiauHI-g", "Lord Verity - Master of Humanity (song)", "Horror Skunx", 6),
    t("is8UDe2PhKQ", "KATSEYE (캣츠아이) 'Hootie Frutti' Official MV", "KATSEYE", 7),
    t("pRpeEdMmmQ0", "Waka Waka", "Shakira", 8),
    t("SOJpE1KMUbo", "Raindance", "Dave & Tems", 9),
    t("m7k9UMcHbr0", "KATSEYE (캣츠아이) Animal Official MV", "KATSEYE", 10),
  ],
  ZZ: [
    t("fcnDmrtj6Sk", "Dai Dai", "Shakira & Burna Boy", 1),
    t("vRjaGgDsWSo", "Casa Tupka Anthemo | @YoYoHoneySingh  feat. Priyanshi | Full Video", "Yo Yo Honey Singh", 2),
    t("vSA7yMrTETg", "Xamdam Sobirov - Peshta / Хамдам Собиров - Пешта / Video Klip", "Xamdam Sobirov", 3),
    t("JqFzhcWo3EU", "Yeshanagula (From The Paradise) (Telugu)", "Jangi Reddy, Singer Prabha & Kasarla Shyam", 4),
    t("BpR280fXISA", "Taylor Swift - Patient Zero (Official Lyric Video)", "Taylor Swift", 5),
    t("s2HYl12gmOY", "Parvati", "Sadhu Tiwari", 6),
    t("3XfUeyDCH6k", "Narayanamma Lyric Video | Aadarsha Kutumbam | Venkatesh, Srinidhi, Nivetha, Dimple Hayati | Thaman S", "Aditya Music", 7),
    t("xvT1jH8B9AM", "KALYANI (Remix)", "ARJN, KDS, FIFTY4 & Shreya Ghoshal", 8),
    t("Pd1yGW_g2T8", "Ashke", "Karan Aujla & Mxrci", 9),
    t("ebZj_nrmH-c", "Barsaat", "Banjaare & Roni", 10),
  ],
};
