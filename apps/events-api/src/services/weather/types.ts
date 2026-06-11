// Shared weather DTO + the provider interface (slice 12). The DTO is
// the wire shape both routes (`/api/v1/ui/events/:id/weather` and
// `/api/v1/sdk/events/:slug/weather`) serialize, and what gets
// persisted into `event_weather.{forecast,air_quality}` jsonb.
//
// The shape is stable across providers — the Open-Meteo impl maps
// its native response into this; future paid providers (WeatherAPI,
// AccuWeather) just need to fulfil the same contract.

export interface WeatherProviderResult {
  forecast: WeatherForecastDto | null
  airQuality: AirQualityDto | null
  // Provider-side timestamp the response was issued (model run time
  // when available, falls back to fetch time). Used for staleness
  // accounting independently of when the row was upserted.
  issuedAt: string // ISO-8601
}

// Daily summary across the event window plus a small "current" block.
// Units: temperatures in Celsius, precipitation in mm, wind in km/h,
// UV index dimensionless. The client converts for display.
export interface WeatherForecastDto {
  units: {
    temperature: 'C'
    precipitation: 'mm'
    windSpeed: 'km/h'
  }
  current: {
    temperature: number | null
    apparentTemperature: number | null
    windSpeed: number | null
    weatherCode: number | null
    isDay: boolean | null
  } | null
  daily: Array<{
    date: string // YYYY-MM-DD
    temperatureMax: number | null
    temperatureMin: number | null
    precipitationSum: number | null
    precipitationProbabilityMax: number | null
    windSpeedMax: number | null
    uvIndexMax: number | null
    weatherCode: number | null
    sunrise: string | null // ISO-8601
    sunset: string | null
  }>
}

export interface AirQualityDto {
  current: {
    usAqi: number | null
    europeanAqi: number | null
    pm2_5: number | null
    pm10: number | null
    ozone: number | null
    dust: number | null
  } | null
  // A small forecast window — the daily max/avg over the event range.
  daily: Array<{
    date: string
    usAqiMax: number | null
    pm2_5Mean: number | null
    pm10Mean: number | null
  }>
}

export interface WeatherProviderInput {
  lat: number
  lng: number
  // YYYY-MM-DD. The provider trims its forecast to this window when
  // possible. start_date defaults to today if absent; end_date to
  // start + 7d if absent.
  startDate: string | null
  endDate: string | null
  // IANA timezone. Open-Meteo uses this to align "daily" buckets.
  timezone: string
}

export interface WeatherProvider {
  // Throws on transport / unrecoverable errors so the caller can
  // categorize. Returns partial results (`forecast` or `airQuality`
  // null) when one of the two API calls succeeded and the other
  // didn't — the route still serves what's available.
  getEventWeather(input: WeatherProviderInput): Promise<WeatherProviderResult>
}
