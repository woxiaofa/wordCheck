/*
 * 教材目录树（版本 → 册 → 单元）—— 由 scripts/build-waiyan.js 生成，请勿手改
 *
 * 为什么单独一个文件：老师的第一个动作是"布置 Unit 3"，
 * 而"四上有几个 Unit、每个 Unit 多少词"这件事必须在端上就能答，
 * 不能每次都去云端问一遍（离线也要能布置/续练）。
 * 词条侧的对应关系写在 words.js 的 book / volume / unit / unit_order 四个字段上。
 */

module.exports = {
  "books": [
    {
      "key": "wy3s",
      "name": "外研版（三年级起点）",
      "desc": "外语教学与研究出版社 · 三年级起点",
      "volumes": [
        {
          "key": "wy4a",
          "name": "四年级上册",
          "tag": "外研四上",
          "book_key": "wy3s",
          "units": [
            {
              "no": 1,
              "name": "I love sports",
              "count": 28
            },
            {
              "no": 2,
              "name": "Helping at home",
              "count": 42
            },
            {
              "no": 3,
              "name": "What's the weather like?",
              "count": 27
            },
            {
              "no": 4,
              "name": "Wonderful seasons",
              "count": 20
            },
            {
              "no": 5,
              "name": "Let's go!",
              "count": 26
            },
            {
              "no": 6,
              "name": "Find your way",
              "count": 20
            }
          ]
        }
      ]
    }
  ]
};
