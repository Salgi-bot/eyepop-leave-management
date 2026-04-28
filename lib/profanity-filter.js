// 한국어 부적절 표현 검출 (회사 인사 시스템용 — 명백한 욕설만)
// 정상 업무 사유가 차단되지 않도록 보수적으로 운영. 의심 시 단어 제거.

const PROFANITY = [
  // 한국어 욕설 (변형 포함)
  '시발', '씨발', '씨바', '쒸발', '시팔', '씨파', '쉬발', '쉬빨', '시벌', '씨벌',
  'ㅅㅂ', 'ㅆㅂ',
  '병신', '븅신', '븅쉰', 'ㅂㅅ',
  '개새', '개색', '개세끼',
  '미친놈', '미친년', '미쳤',
  '좆', '좇', '좋같',
  '존나', '졸라', '존멋', '존맛', '존잘',
  '꺼져',
  '죽어버',
  '걸레같',
  '창녀',
  '엿먹',
  '닥쳐',
  '지랄',
  '새끼', '쌔끼', '쌔키',
  '븅딱',
  '븅맞',
  '뒤져',
  '뒈져',
  '엿같',
  '좆같',
  // 영어
  'fuck', 'shit', 'bitch', 'asshole'
];

// 입력 사유에 부적절 표현이 포함되어 있으면 true
export function containsProfanity(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase().replace(/\s/g, '');
  return PROFANITY.some(w => normalized.includes(w.toLowerCase()));
}
