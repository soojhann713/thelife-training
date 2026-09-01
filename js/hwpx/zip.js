// .hwpx(ZIP) 읽기/쓰기. JSZip 구현을 **주입** 받으므로 브라우저와 Node 테스트가 같은 코드를 씁니다.
//   - 브라우저: CDN 의 window.JSZip (첫 내보내기 때 지연 로드)
//   - Node 테스트: devDependency 의 jszip
//
// HWPX 는 OCF(ODF 계열) 컨테이너라 `mimetype` 이 **첫 엔트리이자 무압축(STORED)** 이어야 합니다.

const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

let loading = null;

/** 브라우저에서 JSZip 을 한 번만 지연 로드합니다. */
export function loadJSZip() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("브라우저 환경이 아닙니다 — zip 구현을 주입하세요"));
  }
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = JSZIP_URL;
    el.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error("JSZip 로드 실패")));
    el.onerror = () => {
      loading = null;
      reject(new Error("압축 라이브러리를 불러오지 못했습니다. 네트워크를 확인해 주세요."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/** .hwpx 바이트 → { names: [...], read(name): Uint8Array, readText(name): string } */
export async function openHwpx(JSZip, bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = [];
  zip.forEach((path, file) => { if (!file.dir) names.push(path); });
  return {
    names,
    has: (name) => names.includes(name),
    read: (name) => zip.file(name).async("uint8array"),
    readText: (name) => zip.file(name).async("string"),
  };
}

/**
 * 엔트리들을 다시 .hwpx 로 묶습니다.
 * 넘어온 키 순서를 지키되 mimetype 은 무조건 맨 앞·무압축으로 둡니다.
 * 한글이 쓴 원본에는 디렉터리 엔트리가 없으므로 createFolders 를 끕니다.
 */
export async function packHwpx(JSZip, entries, { type = "blob" } = {}) {
  const zip = new JSZip();
  const names = Object.keys(entries);
  if (!names.includes("mimetype")) throw new Error("mimetype 엔트리가 없습니다 — HWPX 가 아닙니다");

  zip.file("mimetype", entries.mimetype, { compression: "STORE", createFolders: false });
  for (const name of names) {
    if (name === "mimetype") continue;
    zip.file(name, entries[name], { compression: "DEFLATE", createFolders: false });
  }
  return zip.generateAsync({
    type,
    mimeType: "application/hwp+zip",
    compression: "DEFLATE",
  });
}
