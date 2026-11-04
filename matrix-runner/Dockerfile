FROM python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0
# Runtime seccomp library is present in Debian's base; verify before publishing.
RUN apt-get update && apt-get install -y --no-install-recommends libseccomp2=2.5.4-1+deb12u1 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/judge
COPY requirements.txt /opt/judge/requirements.txt
RUN pip install --no-cache-dir --no-deps -r requirements.txt \
    && pip check \
    && python -c 'import ctypes; ctypes.CDLL("libseccomp.so.2")' \
    && mkdir -p /work \
    && chmod 0755 /tmp /var/tmp /work
COPY controller.py probe.py matrices.json /opt/judge/
RUN chmod -R a-w /opt/judge && chmod 0555 /opt/judge
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /work
CMD ["sleep", "infinity"]
