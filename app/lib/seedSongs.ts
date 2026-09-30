// Emergency fallback: real weekly Top Songs (Sep 18-24 2026). Served only when live charts are unreachable.
import type { ChartTrack } from "./analyticsCharts";

function t(rank: number, videoId: string, title: string, artists: string, weeklyViews: number, previousRank: number | null): ChartTrack {
  const trend = previousRank == null || previousRank <= 0 ? "new" : previousRank === rank ? "same" : previousRank > rank ? "up" : "down";
  return { rank, videoId, title, artists, weeklyViews, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, previousRank: previousRank && previousRank > 0 ? previousRank : null, weeksOnChart: null, trend };
}

export const SEED_SONGS: Record<string, ChartTrack[]> = {
  US: [
    t(1, "nUsrYVxrDwI", "Choosin' Texas", "Ella Langley", 6472638, 1),
    t(2, "fcnDmrtj6Sk", "Dai Dai", "Shakira, Burna Boy", 4665675, 2),
    t(3, "fRIhCiUVaKs", "BbY WOW", "KAROL G, Judeline, rusowsky", 4241029, 3),
    t(4, "is8UDe2PhKQ", "Hootie Frutti", "KATSEYE", 3755073, 4),
    t(5, "yebNIHKAC4A", "Golden", "HUNTR/X, EJAE, AUDREY NUNA, REI AMI, KPop Demon Hunters Cast", 3493355, 7),
    t(6, "ApXoWvfEYVU", "Sunflower", "Post Malone, Swae Lee", 3443841, 5),
    t(7, "m7k9UMcHbr0", "Animal", "KATSEYE", 3315273, 6),
    t(8, "qJKcADiAuAw", "misery.", "pupsies", 2815535, 8),
    t(9, "xxFjwI1qYmc", "WTF GOIN (feat. 21 Savage)", "Belly Gang Kushington", 2733231, 10),
    t(10, "Tk9TM7-eTmw", "Joseph", "Falling in Reverse, Corey Taylor, Serj Tankian", 2690751, 15),
  ],
  IN: [
    t(1, "s2HYl12gmOY", "Parvati", "Sadhu Tiwari", 47266182, 1),
    t(2, "xvT1jH8B9AM", "KALYANI (Remix)", "ARJN, KDS, FIFTY4, Shreya Ghoshal", 35146838, 2),
    t(3, "JqFzhcWo3EU", "Yeshanagula", "Prabha Bangarigalla, Jangi Reddy, Kasarla Shyam", 29721275, 3),
    t(4, "vRjaGgDsWSo", "Casa Tupka Anthemo", "Yo Yo Honey Singh", 24924053, null),
    t(5, "QnQnz9G2LNw", "Mallepoola Pallaki", "G.V. Prakash Kumar, Dappu Srinu", 21239058, 4),
    t(6, "ebZj_nrmH-c", "Barsaat", "Banjaare, Roni", 20991884, 6),
    t(7, "2gXNDr_6FcE", "Irumudi Kattu", "G.V. Prakash Kumar, Ananthu, Shiva Nirvana, Kalyan Chakravarthy Tripuraneni", 17775160, 5),
    t(8, "A_RV2H2F9jw", "Basinga Balaalu", "Swamy Naresh, Srinidhi Nerella, Kalyan Keys", 15956676, 9),
    t(9, "YyepU5ztLf4", "Shararat", "Shashwat Sachdev, Madhubanti Bagchi, Jasmine Sandlas", 14935841, 10),
    t(10, "yLKKz4-M_y8", "Endhayya Saami", "Shweta Mohan, Ajay Gogavale, Ramajogayya Sastry", 14505581, null),
  ],
  GB: [
    t(1, "fcnDmrtj6Sk", "Dai Dai", "Shakira, Burna Boy", 1500580, 1),
    t(2, "yebNIHKAC4A", "Golden", "HUNTR/X, EJAE, AUDREY NUNA, REI AMI, KPop Demon Hunters Cast", 744483, 2),
    t(3, "is8UDe2PhKQ", "Hootie Frutti", "KATSEYE", 626454, 3),
    t(4, "m7k9UMcHbr0", "Animal", "KATSEYE", 621837, 4),
    t(5, "u2ah9tWTkmk", "Ordinary", "Alex Warren", 598573, 5),
    t(6, "nUsrYVxrDwI", "Choosin' Texas", "Ella Langley", 546692, 6),
    t(7, "qwaVhOZkAek", "Let’s Get Married", "Miley Cyrus", 518427, null),
    t(8, "Lufa9QAFFeY", "new trick", "ROSÉ", 471061, null),
    t(9, "uvY8fdgezLQ", "Midnight Sun", "Zara Larsson", 446750, 9),
    t(10, "n7QlUH0zrPg", "Movin' To The Sun", "HUGEL, Imael Angel, Ultra Naté", 431196, 10),
  ],
};
