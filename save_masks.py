import json, os, urllib.request
data = json.load(open("run2.json"))
os.makedirs("masks", exist_ok=True)
for o in data["data"]["results"]["output"]:
    for i, url in enumerate(o.get("mask_urls", [])):
        ext = "jpg" if o["type"] == "resize_image" else "png"
        name = f'{o["type"]}{"_" + o["region"] if "region" in o else ""}_{i}.{ext}'
        urllib.request.urlretrieve(url, os.path.join("masks", name))