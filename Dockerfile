FROM python:3.10-alpine

RUN adduser -D mailhedgehog
WORKDIR /home/mailhedgehog
USER mailhedgehog

ENV PATH="venv/bin:$PATH"
RUN python -m venv venv
COPY requirements.txt requirements.txt
RUN pip install -r requirements.txt
RUN rm -f requirements.txt

COPY --chown=mailhedgehog:mailhedgehog static static
COPY --chown=mailhedgehog:mailhedgehog templates templates
COPY --chown=mailhedgehog:mailhedgehog mailhedgehog mail.py ./
RUN chmod a+x mailhedgehog

EXPOSE 1025 8025

ENTRYPOINT ["./mailhedgehog"]
