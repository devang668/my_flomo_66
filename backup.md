##

```py

```
##

```py

```
##

```py

```

##

```py

```
##

```py

```
##

```py

```

##

```py

```

##

```py

```


##

```py

```


## 连续对话了
```py
from ai_client import send_ai_request
from prompt import prompt
from ai_voiice_clean import clean_content

choose = ["qian-niu-doubao", r"D:\25515\web_AI_chat\wonderful_wise\test0927\memory\online\mem0\ai_providers.json"]

scene = "luoli"
messages = [
    {"role": "system", "content": prompt.language},
    {"role": "system", "content": getattr(prompt.role, scene)},
    {"role": "user", "content": "Hello!,天空在下雨？我的心也是阴郁的"}
]

print("开始对话 (输入 'quit' 或 'exit' 退出):")

while True:
    user_input = input("你: ")
    if user_input.lower() in ['quit', 'exit']:
        print("对话结束")
        break

    messages.append({"role": "user", "content": user_input})
    response = send_ai_request(choose, messages)

    if isinstance(response, str):
        print("Error occurred:", response)
        continue

    ai_content = response["choices"][0]["message"]["content"]
    print("AI:", ai_content)
    messages.append({"role": "assistant", "content": ai_content})


```




## 已经可以使用角色了


```py
from ai_client import send_ai_request 
from prompt import prompt   # 注意：导入的是实例 prompt
from ai_voiice_clean import clean_content

# 选择提供商和配置文件路径
choose = ["qian-niu-doubao", "D:\\25515\\web_AI_chat\\wonderful_wise\\test0927\\memory\\online\mem0\\ai_providers.json"]

# 准备消息
scene = "luoli"  
messages = [
    {"role": "system", "content": prompt.language},   # 语言锁定
    {"role": "system", "content": getattr(prompt.role, scene)},
    {"role": "user",   "content": "Hello!,天空在下雨？我的心也是阴郁的"}
]
# 发送请求

response = send_ai_request(choose,messages)
# 提取 content
# data = response.json()


# 检查响应是否为错误消息
if isinstance(response, str):
    print("Error occurred:", response)
else:

    content = response["choices"][0]["message"]["content"]

    # 清除不适合的md格式字符
    # print(content)
    # content = clean_content(content)
    print(content)

    content = clean_content(content)
    print("\n\n")
    print(" 干净："+content)
    # print(response)
```
