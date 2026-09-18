# Ome Clone — Random Video Chat (Omegle / Ome.tv სტილი)

სრული backend + frontend პროექტი რანდომ ვიდეო ჩატისთვის.

## ფუნქციები

- **1-ზე-1 რანდომ მეჩინგი** (როგორც Omegle / Ome.tv)
- **ჯგუფური ოთახები** (მაქსიმუმ 4 ადამიანი) — რანდომ ან კოდით
- **ვიდეო + აუდიო** (WebRTC P2P / mesh)
- **ტექსტური ჩატი** რეალურ დროში
- მიკროფონის და კამერის ჩართვა/გამორთვა
- "შემდეგი" ღილაკი
- ლამაზი მუქი UI, responsive (მობილურიც)
- ოთახის კოდის კოპირება და გაზიარება

## ტექნოლოგიები

- Node.js + Express + Socket.io
- WebRTC (native RTCPeerConnection)
- Vanilla JS + თანამედროვე CSS
- უფასო Google STUN (TURN ოპციონალური Twilio-თი)

## გაშვება

```bash
# 1. დააინსტალირე დამოკიდებულებები
npm install

# 2. (ოფციონალური) შექმენი .env
cp .env.example .env
# შეცვალე PORT თუ გინდა

# 3. გაუშვი
npm start
```

გახსენი ბრაუზერში: **http://localhost:3000**

## Production deploy

ყველაზე მარტივი და სტაბილური ვარიანტია მთელი პროექტის **Render Web Service**-ად გაშვება:

1. GitHub-ზე ატვირთე ეს repository.
2. Render-ში შექმენი `Web Service` და მიუთითე repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment-ში დაამატე `TWILIO_ACCOUNT_SID` და `TWILIO_AUTH_TOKEN`.

Render-ის URL-ზე აპი ერთ origin-ზე ემსახურება frontend-საც და Socket.io-საც, ამიტომ `io()` ავტომატურად სწორ backend-ს უკავშირდება. კამერა და მიკროფონი production-ზე იმუშავებს მხოლოდ HTTPS URL-ზე და მომხმარებელმა ბრაუზერში ორივე permission უნდა მისცეს.

Netlify მხოლოდ frontend-ისთვის გამოდგება. ამ შემთხვევაში backend მაინც Render-ზე უნდა იყოს, ხოლო `public/index.html`-ში `window.APP_CONFIG = { socketUrl: 'https://your-render-service.onrender.com' }` უნდა დაემატოს `app.js`-მდე; Render-ზე კი `CLIENT_ORIGIN`-ად Netlify-ს URL უნდა მიუთითო. მხოლოდ Netlify-ზე ამ პროექტის გაშვება Socket.io backend-ის გარეშე ვერ იმუშავებს.

TURN აუცილებელია რთული NAT/firewall ქსელებისთვის. Twilio-ს ჩართვის გარეშე ზოგიერთ მომხმარებელს signaling ექნება, მაგრამ აუდიო/ვიდეო არ გაივლის.

### რამდენიმე ბრაუზერით ტესტი
გახსენი 2–4 ტაბი (ან სხვადასხვა ბრაუზერი / incognito) და სცადე 1v1 ან ჯგუფი.

## .env ცვლადები

```
PORT=3000

# ოპციონალური — უკეთესი კავშირი firewall/NAT-ის მიღმა
# TWILIO_ACCOUNT_SID=ACxxxx
# TWILIO_AUTH_TOKEN=xxxx
```

თუ Twilio-ს დაამატებ, server.js ავტომატურად გამოიყენებს TURN სერვერებს.

## როგორ მუშაობს

1. მომხმარებელი ირჩევს რეჟიმს (1v1 / ჯგუფი / ოთახის შექმნა)
2. Server Socket.io-თი მეჩინგს აკეთებს ან ოთახს ქმნის
3. WebRTC signaling Socket.io-თი გადის (offer/answer/ICE)
4. ვიდეო/აუდიო პირდაპირ peer-to-peer მიდის
5. ჩატი Socket.io-თი ოთახის ყველა წევრს

## შენიშვნები

- **HTTPS** საჭიროა კამერისთვის production-ზე (localhost-ზე HTTP-ც მუშაობს)
- 4-კაციან mesh-ში თითოეულს 3 კავშირი აქვს — კარგი ინტერნეტი სჭირდება
- უფასო STUN უმეტეს შემთხვევაში მუშაობს; რთული NAT-ისთვის TURN დაამატე
- პროდუქციაში დაამატე rate-limit, moderation, reporting და ა.შ.

## ლიცენზია

MIT — თავისუფლად გამოიყენე და შეცვალე.
