FROM apify/actor-python:3.13

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./
RUN python -m compileall -q src/

CMD ["python", "-m", "src"]
