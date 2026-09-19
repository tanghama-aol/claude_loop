### [x] 1. 根据不同的错误，延迟不同时间, 根据次数加大延迟倍率， 如： 10s，连续6次失败20s, 连续10次失败5分钟，连续20次失败10分钟，连续40次失败20分钟，连续50次失败30分钟，连续50次失败50分钟， 成功后再遇到错误又回到10s

1. 遇到"ERROR: Reconnecting... 1/5" 从1分钟开始
2. 遇到"ERROR: We're currently experiencing high demand, which may cause temporary errors." 从5分钟开始
3. 遇到"unexpected status 401 Unauthorized" 从10分钟开始