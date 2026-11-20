// The Health kinds a bot can ask for, as HealthKit names them. No React Native imports.

export type HealthKind =
  | "steps"
  | "distance"
  | "activeEnergy"
  | "exerciseMinutes"
  | "standHours"
  | "flightsClimbed"
  | "heartRate"
  | "restingHeartRate"
  | "heartRateVariability"
  | "sleep"
  | "weight"
  | "bodyFat"
  | "bloodOxygen"
  | "respiratoryRate"
  | "water"
  | "caffeine"
  | "mindfulMinutes"
  | "workouts";

export type HealthType =
  | {
      kind: "quantity";
      id: string;
      /** The HealthKit unit the value is read in. */
      unit: string;
      /** The unit a bot is told. */
      shown: string;
      /** HealthKit keeps percentages as 0 to 1; a bot is told 0 to 100. */
      scale?: number;
      /** How a day's records become one figure. */
      daily: "sum" | "average" | "latest";
    }
  | { kind: "category"; id: string; shown: string }
  | { kind: "workout"; id: string; shown: string };

export const HEALTH_TYPES: Record<HealthKind, HealthType> = {
  steps: { kind: "quantity", id: "HKQuantityTypeIdentifierStepCount", unit: "count", shown: "steps", daily: "sum" },
  distance: { kind: "quantity", id: "HKQuantityTypeIdentifierDistanceWalkingRunning", unit: "km", shown: "km", daily: "sum" },
  activeEnergy: { kind: "quantity", id: "HKQuantityTypeIdentifierActiveEnergyBurned", unit: "kcal", shown: "kcal", daily: "sum" },
  exerciseMinutes: { kind: "quantity", id: "HKQuantityTypeIdentifierAppleExerciseTime", unit: "min", shown: "min", daily: "sum" },
  standHours: { kind: "category", id: "HKCategoryTypeIdentifierAppleStandHour", shown: "hours" },
  flightsClimbed: { kind: "quantity", id: "HKQuantityTypeIdentifierFlightsClimbed", unit: "count", shown: "flights", daily: "sum" },
  heartRate: { kind: "quantity", id: "HKQuantityTypeIdentifierHeartRate", unit: "count/min", shown: "bpm", daily: "average" },
  restingHeartRate: { kind: "quantity", id: "HKQuantityTypeIdentifierRestingHeartRate", unit: "count/min", shown: "bpm", daily: "average" },
  heartRateVariability: { kind: "quantity", id: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", unit: "ms", shown: "ms", daily: "average" },
  sleep: { kind: "category", id: "HKCategoryTypeIdentifierSleepAnalysis", shown: "hours" },
  weight: { kind: "quantity", id: "HKQuantityTypeIdentifierBodyMass", unit: "kg", shown: "kg", daily: "latest" },
  bodyFat: { kind: "quantity", id: "HKQuantityTypeIdentifierBodyFatPercentage", unit: "%", shown: "percent", scale: 100, daily: "latest" },
  bloodOxygen: { kind: "quantity", id: "HKQuantityTypeIdentifierOxygenSaturation", unit: "%", shown: "percent", scale: 100, daily: "average" },
  respiratoryRate: { kind: "quantity", id: "HKQuantityTypeIdentifierRespiratoryRate", unit: "count/min", shown: "breaths/min", daily: "average" },
  water: { kind: "quantity", id: "HKQuantityTypeIdentifierDietaryWater", unit: "mL", shown: "mL", daily: "sum" },
  caffeine: { kind: "quantity", id: "HKQuantityTypeIdentifierDietaryCaffeine", unit: "mg", shown: "mg", daily: "sum" },
  mindfulMinutes: { kind: "category", id: "HKCategoryTypeIdentifierMindfulSession", shown: "min" },
  workouts: { kind: "workout", id: "HKWorkoutTypeIdentifier", shown: "workouts" },
};

export const HEALTH_KINDS = Object.keys(HEALTH_TYPES) as HealthKind[];

/** What `phone_health_summary` reports, in this order. */
export const SUMMARY_KINDS: HealthKind[] = ["steps", "distance", "activeEnergy", "exerciseMinutes", "sleep", "heartRate", "restingHeartRate", "weight", "workouts"];

/** What `phone_health_log` may write, and the range a value must be in (in the unit a bot gives). */
export const HEALTH_LOGS = {
  water: { min: 1, max: 10_000 },
  weight: { min: 1, max: 700 },
  caffeine: { min: 1, max: 2_000 },
  mindfulMinutes: { min: 1, max: 1_440 },
  bodyFat: { min: 1, max: 100 },
} as const;
export type HealthLog = keyof typeof HEALTH_LOGS;

/** The HealthKit types a level asks iOS for: everything a bot may read, and at "interact" what it may write. */
export function healthRequest(level: "read" | "interact"): { toRead: string[]; toShare: string[] } {
  return {
    toRead: HEALTH_KINDS.map((kind) => HEALTH_TYPES[kind].id),
    toShare: level === "interact" ? (Object.keys(HEALTH_LOGS) as HealthLog[]).map((kind) => HEALTH_TYPES[kind].id) : [],
  };
}

/** HealthKit's workout kinds (WorkoutActivityType), by their number, as plain words. */
const WORKOUTS: Record<number, string> = { 1:"americanFootball", 2:"archery", 3:"australianFootball", 4:"badminton", 5:"baseball", 6:"basketball", 7:"bowling", 8:"boxing", 9:"climbing", 10:"cricket", 11:"crossTraining", 12:"curling", 13:"cycling", 14:"dance", 15:"danceInspiredTraining", 16:"elliptical", 17:"equestrianSports", 18:"fencing", 19:"fishing", 20:"functionalStrengthTraining", 21:"golf", 22:"gymnastics", 23:"handball", 24:"hiking", 25:"hockey", 26:"hunting", 27:"lacrosse", 28:"martialArts", 29:"mindAndBody", 30:"mixedMetabolicCardioTraining", 31:"paddleSports", 32:"play", 33:"preparationAndRecovery", 34:"racquetball", 35:"rowing", 36:"rugby", 37:"running", 38:"sailing", 39:"skatingSports", 40:"snowSports", 41:"soccer", 42:"softball", 43:"squash", 44:"stairClimbing", 45:"surfingSports", 46:"swimming", 47:"tableTennis", 48:"tennis", 49:"trackAndField", 50:"traditionalStrengthTraining", 51:"volleyball", 52:"walking", 53:"waterFitness", 54:"waterPolo", 55:"waterSports", 56:"wrestling", 57:"yoga", 58:"barre", 59:"coreTraining", 60:"crossCountrySkiing", 61:"downhillSkiing", 62:"flexibility", 63:"highIntensityIntervalTraining", 64:"jumpRope", 65:"kickboxing", 66:"pilates", 67:"snowboarding", 68:"stairs", 69:"stepTraining", 70:"wheelchairWalkPace", 71:"wheelchairRunPace", 72:"taiChi", 73:"mixedCardio", 74:"handCycling", 75:"discSports", 76:"fitnessGaming", 77:"cardioDance", 78:"socialDance", 79:"pickleball", 80:"cooldown", 82:"swimBikeRun", 83:"transition", 84:"underwaterDiving", 2998:"rest", 2999:"group", 3000:"other" };
export const workoutName = (type: number) => (WORKOUTS[type] ?? "other").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
